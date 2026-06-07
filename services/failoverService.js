/**
 * Failover Service
 *
 * Monitors node health for multi-node website deployments and
 * automatically fails over to secondary/backup nodes when the
 * primary node goes offline or becomes unhealthy.
 *
 * Failover chain:
 *   Primary Node → Secondary Node → Backup Node → VPS Fallback
 *
 * The client never sees downtime — traffic is transparently
 * routed to the next available node.
 */

const Website = require('../models/Website');
const Node = require('../models/Node');
const Alert = require('../models/Alert');
const proxyService = require('./proxyService');
const logger = require('../config/logger');

const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

/**
 * Check all active websites and perform failover if needed.
 */
async function checkAndFailover(io) {
  try {
    // Find websites with multi-node setup that are active
    const websites = await Website.find({
      status: 'active',
      // Has at least primary + secondary OR primary + backup
      $or: [
        { secondaryNode: { $ne: null } },
        { fallbackNode: { $ne: null } },
      ],
    })
      .populate('primaryNode', 'nodeId name status mode metrics')
      .populate('secondaryNode', 'nodeId name status mode metrics')
      .populate('fallbackNode', 'nodeId name status mode metrics')
      .populate('activeNode', 'nodeId name status')
      .lean();

    for (const site of websites) {
      await evaluateSiteHealth(site, io);
    }
  } catch (error) {
    logger.error('Failover check failed:', error.message);
  }
}

/**
 * Evaluate a single site's health and perform failover if needed.
 */
async function evaluateSiteHealth(site, io) {
  const activeNode = site.activeNode || site.primaryNode;
  if (!activeNode) return;

  const isNodeHealthy = activeNode.status === 'online' &&
    activeNode.mode !== 'OFFLINE' &&
    activeNode.mode !== 'GAMING' &&
    (activeNode.metrics?.cpuPercent || 0) < 85;

  if (isNodeHealthy) return; // Everything is fine

  // Determine which node to fail over to
  // Priority: TRAFFIC_NODE/COMPUTE_NODE > BACKUP_NODE > VPS fallback
  let targetNode = null;
  let failoverReason = '';

  if (activeNode.status === 'offline') {
    failoverReason = `Node ${activeNode.name} went offline`;
  } else if (activeNode.mode === 'GAMING') {
    failoverReason = `Node ${activeNode.name} entered GAMING mode`;
  } else if ((activeNode.metrics?.cpuPercent || 0) >= 85) {
    failoverReason = `Node ${activeNode.name} CPU at ${activeNode.metrics?.cpuPercent}%`;
  } else {
    failoverReason = `Node ${activeNode.name} is unhealthy`;
  }

  // Collect candidate nodes from the website's assigned nodes
  const candidateIds = [
    site.secondaryNode?._id,
    site.fallbackNode?._id,
    ...(site.assignedNodes || []).map(n => n._id).filter(id => {
      const idStr = id.toString();
      return idStr !== site.primaryNode?._id?.toString() &&
             idStr !== site.secondaryNode?._id?.toString() &&
             idStr !== site.fallbackNode?._id?.toString();
    }),
  ].filter(Boolean);

  // Remove duplicates and the current active node
  const uniqueIds = [...new Set(candidateIds.map(id => id.toString()))]
    .filter(id => id !== activeNode._id?.toString());

  if (uniqueIds.length > 0) {
    // Find the best healthy node — prefer TRAFFIC_NODE over BACKUP_NODE
    const candidates = await Node.find({
      _id: { $in: uniqueIds.map(id => require('mongoose').Types.ObjectId(id)) },
      status: 'online',
      mode: { $nin: ['OFFLINE', 'GAMING'] },
    })
      .sort({ type: 1, score: -1 }) // TRAFFIC_NODE first (alphabetically), then by score
      .lean();

    // Pick the best candidate: prefer non-BACKUP_NODE types
    const bestCandidate = candidates.find(n => n.type !== 'BACKUP_NODE') || candidates[0];
    if (bestCandidate) {
      targetNode = bestCandidate;
    }
  }

  if (!targetNode) {
    logger.warn(`No failover target for ${site.domain} — routing to VPS fallback`);
    // Set website to VPS fallback mode — Caddy will route to a local maintenance page
    await Website.updateOne(
      { siteId: site.siteId },
      {
        $set: {
          activeNode: null,
          healthStatus: 'down',
        },
        $inc: { failoverCount: 1 },
        $push: {
          failoverHistory: {
            from: activeNode._id,
            to: null,
            reason: failoverReason + ' — VPS fallback activated',
            timestamp: new Date(),
          },
        },
      }
    );
    await createFailoverAlert(site, failoverReason, 'vps_fallback', io);
    // Update proxy to serve fallback page
    proxyService.generateCaddyfile().catch(() => {});
    proxyService.reloadCaddy().catch(() => {});
    return;
  }

  // Check if target node is healthy — must be actively serving, not gaming
  const isTargetHealthy = targetNode.status === 'online' &&
    targetNode.mode !== 'OFFLINE' &&
    targetNode.mode !== 'GAMING' &&
    (targetNode.metrics?.cpuPercent || 0) < 80;

  if (!isTargetHealthy) {
    logger.warn(`Failover target ${targetNode.name} is also unhealthy for ${site.domain}`);
    await createFailoverAlert(site, failoverReason, 'target_unhealthy', io);
    return;
  }

  // Perform the failover
  logger.info(`Failing over ${site.domain} from ${activeNode.name} to ${targetNode.name}: ${failoverReason}`);

  await Website.updateOne(
    { siteId: site.siteId },
    {
      $set: {
        activeNode: targetNode._id,
        lastFailoverAt: new Date(),
      },
      $inc: { failoverCount: 1 },
      $push: {
        failoverHistory: {
          from: activeNode._id,
          to: targetNode._id,
          reason: failoverReason,
          timestamp: new Date(),
        },
      },
    }
  );

  // Update proxy routing for the failover
  const deployment = await require('../models/Deployment').findOne({
    siteId: site.siteId,
    status: 'active',
  }).sort({ version: -1 }).lean();

  if (deployment) {
    // Re-register site with proxy using the new active node
    await proxyService.registerSite(deployment.deploymentId).catch(() => {});
    await proxyService.generateCaddyfile().catch(() => {});
    await proxyService.reloadCaddy().catch(() => {});
  }

  // Create alert
  await createFailoverAlert(site, failoverReason, `failed_over_to_${targetNode.name}`, io);

  // Emit real-time update
  if (io) {
    io.to('admin').emit('website:failover', {
      siteId: site.siteId,
      domain: site.domain,
      from: activeNode.name,
      to: targetNode.name,
      reason: failoverReason,
    });
  }
}

/**
 * Create a failover alert.
 */
async function createFailoverAlert(site, reason, action, io) {
  const Alert = require('../models/Alert');
  const { v4: uuidv4 } = require('uuid');

  const alert = await Alert.create({
    alertId: `alert_${uuidv4().split('-')[0]}`,
    type: 'website_down',
    severity: action === 'no_target' ? 'critical' : 'warning',
    message: `Website ${site.domain}: ${reason}. Action: ${action}`,
    nodeId: site.activeNode?.nodeId || '',
    nodeName: site.activeNode?.name || '',
    metadata: {
      siteId: site.siteId,
      domain: site.domain,
      reason,
      action,
    },
  });

  if (io) {
    io.to('admin').emit('alert:new', alert.toJSON());
  }
}

/**
 * Start the failover monitoring service.
 */
function startFailoverService(io) {
  logger.info('Starting failover monitoring service (interval: 30s)');
  checkAndFailover(io);
  return setInterval(() => checkAndFailover(io), CHECK_INTERVAL_MS);
}

module.exports = {
  checkAndFailover,
  startFailoverService,
};
