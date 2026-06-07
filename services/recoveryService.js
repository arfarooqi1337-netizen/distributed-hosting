/**
 * Recovery service
 *
 * Handles automatic workload restoration when a node comes back online.
 *
 * Flow:
 * 1. Node reconnects and sends heartbeat
 * 2. Controller detects node was previously offline
 * 3. Checks all deployments assigned to this node
 * 4. Sends list_containers command to verify container existence
 * 5. For missing containers, re-dispatches deploy_site
 * 6. Updates website health and nodeResults
 * 7. Logs recovery events and creates alerts
 */

const { v4: uuidv4 } = require('uuid');
const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const Website = require('../models/Website');
const Command = require('../models/Command');
const Alert = require('../models/Alert');
const logger = require('../config/logger');

/**
 * Poll for a deployment to become active on a node.
 * Returns the deployment doc or null on timeout.
 */
async function waitForDeploymentActive(deploymentId, nodeId, timeoutMs = 30000) {
  const pollInterval = 1500;
  let waited = 0;

  while (waited < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    waited += pollInterval;

    const dep = await Deployment.findOne({ deploymentId }).lean();
    if (!dep) return null;

    // Check nodeResults for this node
    if (dep.nodeResults && Array.isArray(dep.nodeResults)) {
      const nr = dep.nodeResults.find(n => n.nodeId === nodeId);
      if (nr && nr.status === 'active') return dep;
    }

    // Check deployment-level status
    if (dep.status === 'active') return dep;
    if (dep.status === 'failed') return null;
  }

  return null;
}

/**
 * Perform an HTTP health check on a website domain/port.
 * Returns 'healthy', 'degraded', or 'down'.
 */
async function httpHealthCheck(domain, port) {
  return new Promise((resolve) => {
    const http = require('http');
    const target = port ? `${domain}:${port}` : domain;
    const url = `http://${target}/`;

    const req = http.get(url, { timeout: 8000 }, (res) => {
      res.resume();
      const code = res.statusCode || 0;
      if (code >= 200 && code < 400) resolve('healthy');
      else if (code >= 400 && code < 500) resolve('degraded');
      else resolve('down');
    });

    req.on('timeout', () => { req.destroy(); resolve('down'); });
    req.on('error', () => resolve('down'));
  });
}

/**
 * Check if a node needs workload recovery after coming back online.
 * Called from heartbeat processing when node transitions from offline to online.
 *
 * @param {Object} node - The Node document
 * @param {Object} io - Socket.IO instance
 */
async function checkAndRecoverNode(node, io) {
  if (!node || !node.nodeId) return;

  try {
    logger.info(`Recovery check for node ${node.name} (${node.nodeId})`);

    // Find all active deployments assigned to this node
    const activeDeployments = await Deployment.find({
      assignedNodeId: node.nodeId,
      status: { $in: ['active', 'dispatching', 'deploying'] },
    }).lean();

    if (activeDeployments.length === 0) {
      logger.debug(`No active deployments to restore for node ${node.name}`);
      return;
    }

    // Find deployments in nodeResults as well (multi-node setups)
    const nodeResultDeployments = await Deployment.find({
      'nodeResults.nodeId': node.nodeId,
      status: { $in: ['active', 'dispatching', 'deploying'] },
    }).lean();

    // Merge unique deployments
    const seenDeploymentIds = new Set();
    const allDeployments = [...activeDeployments, ...nodeResultDeployments].filter(d => {
      if (seenDeploymentIds.has(d.deploymentId)) return false;
      seenDeploymentIds.add(d.deploymentId);
      return true;
    });

    logger.info(`Node ${node.name} has ${allDeployments.length} deployment(s) to verify`);

    const restored = [];
    const failed = [];

    for (const deployment of allDeployments) {
      try {
        const success = await restoreDeploymentOnNode(deployment, node, io);
        if (success) {
          restored.push(deployment.deploymentId);
        } else {
          failed.push(deployment.deploymentId);
        }
      } catch (err) {
        logger.error(`Recovery failed for ${deployment.deploymentId}: ${err.message}`);
        failed.push(deployment.deploymentId);
      }
    }

    // Create recovery summary alert
    if (restored.length > 0 || failed.length > 0) {
      const alert = await Alert.create({
        alertId: `alert_${uuidv4().split('-')[0]}`,
        type: 'node_recovery',
        severity: failed.length > 0 ? 'warning' : 'info',
        message: `Node ${node.name} recovered: ${restored.length} workload(s) restored${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
        nodeId: node.nodeId,
        nodeName: node.name,
        metadata: { restored, failed, totalChecked: allDeployments.length },
      });

      if (io) {
        io.to('admin').emit('alert:new', alert.toJSON());
        io.to('admin').emit('node:recovery', {
          nodeId: node.nodeId,
          nodeName: node.name,
          restored: restored.length,
          failed: failed.length,
        });
      }
    }

    logger.info(`Recovery complete for node ${node.name}: ${restored.length} restored, ${failed.length} failed`);
  } catch (error) {
    logger.error(`Recovery check failed for node ${node.nodeId}: ${error.message}`);
  }
}

/**
 * Restore a single deployment on a node.
 * Re-dispatches deploy_site command, waits for completion, and health-checks.
 */
async function restoreDeploymentOnNode(deployment, node, io) {
  // Find the website for this deployment
  const website = await Website.findOne({ siteId: deployment.siteId }).lean();
  if (!website) {
    logger.warn(`Cannot restore deployment ${deployment.deploymentId}: website ${deployment.siteId} not found`);
    return false;
  }

  // Only restore if this node is assigned to the website
  const nodeDoc = await Node.findOne({ nodeId: node.nodeId });
  if (!nodeDoc) return false;

  const isActive = website.activeNode && website.activeNode.toString() === nodeDoc._id.toString();
  const isInAssigned = (website.assignedNodes || []).some(
    n => n.toString() === nodeDoc._id.toString()
  );

  if (!isActive && !isInAssigned) {
    logger.debug(`Skipping restore for ${deployment.deploymentId}: node not assigned`);
    return false;
  }

  // Create restore command
  const commandId = uuidv4();
  const cmd = await Command.create({
    commandId,
    nodeId: node.nodeId,
    command: 'deploy_site',
    params: {
      deploymentId: deployment.deploymentId,
      siteId: deployment.siteId,
      domain: deployment.domain,
      artifactPath: deployment.artifactPath || '',
      restoreMode: true,
    },
    status: 'pending',
    createdBy: 'system',
  });

  // Send command via Socket.IO
  if (io) {
    io.to(`node:${node.nodeId}`).emit('command:new', {
      commandId,
      command: 'deploy_site',
      params: cmd.params,
    });
  }

  logger.info(`Restore command dispatched: ${deployment.deploymentId} → node ${node.name}`);

  // Wait for deployment to become active (up to 60s)
  const activeDep = await waitForDeploymentActive(deployment.deploymentId, node.nodeId, 60000);
  if (!activeDep) {
    logger.warn(`Restore timeout for ${deployment.deploymentId} on ${node.name}`);

    try {
      await Alert.create({
        alertId: `alert_${uuidv4().split('-')[0]}`,
        type: 'recovery_failed',
        severity: 'critical',
        message: `Workload restoration failed for ${deployment.domain} on node ${node.name} — deployment did not become active`,
        nodeId: node.nodeId,
        nodeName: node.name,
        metadata: { deploymentId: deployment.deploymentId, siteId: deployment.siteId },
      });
    } catch (alertErr) {
      logger.warn(`Could not create recovery alert: ${alertErr.message}`);
    }

    if (io) {
      io.to('admin').emit('alert:new', {
        type: 'recovery_failed',
        severity: 'critical',
        message: `Workload restoration failed for ${deployment.domain} on node ${node.name}`,
      });
    }

    return false;
  }

  // Perform HTTP health check on the restored site
  const exposedPort = activeDep.containerInfo?.exposedPort || deployment.containerInfo?.exposedPort;
  const healthResult = await httpHealthCheck(website.domain, exposedPort);

  // Update website health status
  await Website.updateOne(
    { siteId: deployment.siteId },
    {
      $set: {
        healthStatus: healthResult,
        lastHealthCheck: new Date(),
      },
    }
  );

  if (healthResult === 'healthy') {
    logger.info(`Restore successful: ${deployment.domain} → healthy on node ${node.name}`);

    if (io) {
      io.to('admin').emit('deployment:update', activeDep);
      io.to('admin').emit('website:update', {
        siteId: deployment.siteId,
        domain: deployment.domain,
        healthStatus: 'healthy',
      });
    }

    return true;
  }

  // Health check failed or degraded
  logger.warn(`Restore health check ${healthResult} for ${deployment.domain} on ${node.name}`);

  try {
    await Alert.create({
      alertId: `alert_${uuidv4().split('-')[0]}`,
      type: 'recovery_failed',
      severity: healthResult === 'down' ? 'critical' : 'warning',
      message: `Website ${deployment.domain} restored on ${node.name} but health check returned ${healthResult}`,
      nodeId: node.nodeId,
      nodeName: node.name,
      metadata: { deploymentId: deployment.deploymentId, healthStatus: healthResult },
    });
  } catch (alertErr) {
    logger.warn(`Could not create health alert: ${alertErr.message}`);
  }

  return false;
}

module.exports = {
  checkAndRecoverNode,
  restoreDeploymentOnNode,
};
