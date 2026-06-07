/**
 * Failover Service
 *
 * Monitors node health for multi-node website deployments and
 * automatically fails over to the next available node using
 * explicit tiered priority:
 *
 *   Current active node fails
 *   -> Tier 1: Healthy assigned TRAFFIC_NODE (IDLE/NORMAL)
 *   -> Tier 2: Healthy assigned COMPUTE_NODE capable of hosting
 *   -> Tier 3: Healthy assigned BACKUP_NODE
 *   -> Final:  VPS fallback.html served from Main VPS
 *
 * The client never sees downtime -- traffic is transparently
 * routed to the next available node.
 */

const mongoose = require('mongoose');
const Website = require('../models/Website');
const Node = require('../models/Node');
const Alert = require('../models/Alert');
const proxyService = require('./proxyService');
const logger = require('../config/logger');

const CHECK_INTERVAL_MS = 30000;

async function checkAndFailover(io) {
  try {
    const websites = await Website.find({
      status: 'active',
      $or: [
        { secondaryNode: { $ne: null } },
        { fallbackNode: { $ne: null } },
      ],
    })
      .populate('primaryNode', 'nodeId name status mode metrics type')
      .populate('secondaryNode', 'nodeId name status mode metrics type')
      .populate('fallbackNode', 'nodeId name status mode metrics type')
      .populate('activeNode', 'nodeId name status type')
      .lean();

    for (const site of websites) {
      await evaluateSiteHealth(site, io);
    }
  } catch (error) {
    logger.error('Failover check failed:', error.message);
  }
}

async function evaluateSiteHealth(site, io) {
  const activeNode = site.activeNode || site.primaryNode;
  if (!activeNode) return;

  const isNodeHealthy = activeNode.status === 'online' &&
    activeNode.mode !== 'OFFLINE' &&
    activeNode.mode !== 'GAMING' &&
    (activeNode.metrics?.cpuPercent || 0) < 85;

  if (isNodeHealthy) return;

  let failoverReason = '';
  if (activeNode.status === 'offline') {
    failoverReason = 'Node ' + activeNode.name + ' went offline';
  } else if (activeNode.mode === 'GAMING') {
    failoverReason = 'Node ' + activeNode.name + ' entered GAMING mode';
  } else if ((activeNode.metrics?.cpuPercent || 0) >= 85) {
    failoverReason = 'Node ' + activeNode.name + ' CPU at ' + activeNode.metrics.cpuPercent + '%';
  } else {
    failoverReason = 'Node ' + activeNode.name + ' is unhealthy';
  }

  const assignedIds = [
    site.primaryNode?._id,
    site.secondaryNode?._id,
    site.fallbackNode?._id,
    ...(site.assignedNodes || []).map(n => (n._id || n)),
  ]
    .filter(Boolean)
    .map(id => id.toString());

  const candidateIds = [...new Set(assignedIds)]
    .filter(id => id !== activeNode._id?.toString());

  if (candidateIds.length === 0) {
    await goToVpsFallback(site, failoverReason, io);
    return;
  }

  const targetNode = await findBestFailoverTarget(candidateIds, site);

  if (!targetNode) {
    await goToVpsFallback(site, failoverReason, io);
    return;
  }

  const isTargetHealthy = targetNode.status === 'online' &&
    targetNode.mode !== 'OFFLINE' &&
    targetNode.mode !== 'GAMING' &&
    (targetNode.metrics?.cpuPercent || 0) < 80;

  if (!isTargetHealthy) {
    logger.warn('Failover target ' + targetNode.name + ' is also unhealthy for ' + site.domain);
    await goToVpsFallback(site, failoverReason + ' (tried ' + targetNode.name + ')', io);
    return;
  }

  logger.info('Failing over ' + site.domain + ': ' + activeNode.name + ' -> ' + targetNode.name);

  await Website.updateOne(
    { siteId: site.siteId },
    {
      $set: { activeNode: targetNode._id, healthStatus: 'degraded' },
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

  const Deployment = require('../models/Deployment');
  const deployment = await Deployment.findOne({
    siteId: site.siteId,
    status: 'active',
  }).sort({ createdAt: -1 }).lean();

  if (deployment && site.domain) {
    await proxyService.registerSite({
      siteId: site.siteId,
      domain: site.domain,
      deploymentId: deployment.deploymentId,
      nodeId: targetNode.nodeId,
      nodeName: targetNode.name,
      port: deployment.containerInfo?.exposedPort || 8080,
      targetAddress: targetNode.tunnelEndpoint || 'localhost:' + (deployment.containerInfo?.exposedPort || 8080),
    });
  }

  await createFailoverAlert(site, failoverReason, 'failover_completed', io);

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
 * Tier 1: TRAFFIC_NODE (IDLE/NORMAL)
 * Tier 2: COMPUTE_NODE (IDLE/NORMAL/GAMING)
 * Tier 3: BACKUP_NODE (online, not OFFLINE)
 */
async function findBestFailoverTarget(candidateIds, site) {
  const objectIds = candidateIds.map(function(id) {
    return new mongoose.Types.ObjectId(id);
  });

  // Tier 1: Healthy TRAFFIC_NODE
  var candidates = await Node.find({
    _id: { $in: objectIds },
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL'] },
    type: 'TRAFFIC_NODE',
  }).sort({ score: -1 }).limit(5).lean();

  if (candidates.length > 0) {
    logger.info('[Failover Tier 1] Using TRAFFIC_NODE: ' + candidates[0].name);
    return candidates[0];
  }

  // Tier 2: Healthy COMPUTE_NODE
  candidates = await Node.find({
    _id: { $in: objectIds },
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL', 'GAMING'] },
    type: 'COMPUTE_NODE',
  }).sort({ score: -1 }).limit(5).lean();

  if (candidates.length > 0) {
    logger.info('[Failover Tier 2] Using COMPUTE_NODE: ' + candidates[0].name);
    return candidates[0];
  }

  // Tier 3: BACKUP_NODE (last resort)
  candidates = await Node.find({
    _id: { $in: objectIds },
    status: 'online',
    mode: { $ne: 'OFFLINE' },
    type: 'BACKUP_NODE',
  }).sort({ score: -1 }).limit(5).lean();

  if (candidates.length > 0) {
    logger.info('[Failover Tier 3] Falling back to BACKUP_NODE: ' + candidates[0].name);
    return candidates[0];
  }

  return null;
}

async function goToVpsFallback(site, reason, io) {
  logger.warn('VPS fallback for ' + site.domain + ': ' + reason);

  await Website.updateOne(
    { siteId: site.siteId },
    {
      $set: { activeNode: null, healthStatus: 'down' },
      $inc: { failoverCount: 1 },
      $push: {
        failoverHistory: {
          from: site.activeNode?._id,
          to: null,
          reason: reason + ' -- VPS fallback',
          timestamp: new Date(),
        },
      },
    }
  );

  await createFailoverAlert(site, reason, 'vps_fallback', io);
  proxyService.generateCaddyfile().catch(function() {});
  proxyService.reloadCaddy().catch(function() {});

  if (io) {
    io.to('admin').emit('website:failover', {
      siteId: site.siteId,
      domain: site.domain,
      from: site.activeNode?.name || 'unknown',
      to: 'VPS fallback',
      reason: reason,
    });
  }
}

async function createFailoverAlert(site, reason, action, io) {
  var uuidv4 = require('uuid').v4;
  try {
    var alert = await Alert.create({
      alertId: 'alert_' + uuidv4().split('-')[0],
      type: 'failover',
      severity: action === 'vps_fallback' ? 'critical' : 'warning',
      message: 'Failover for ' + site.domain + ': ' + reason,
      nodeId: site.activeNode?.nodeId || '',
      nodeName: site.activeNode?.name || 'unknown',
      metadata: { siteId: site.siteId, domain: site.domain, action: action },
    });
    if (io) {
      io.to('admin').emit('alert:new', alert.toJSON());
    }
  } catch (error) {
    logger.error('Failed to create failover alert:', error.message);
  }
}

function startFailoverService(io) {
  checkAndFailover(io);
  return setInterval(function() {
    checkAndFailover(io);
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  startFailoverService: startFailoverService,
  checkAndFailover: checkAndFailover,
};
