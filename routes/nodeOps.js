/**
 * Node Operations routes
 *
 * Hosting management layer — drain, evacuate, maintenance mode.
 */
const express = require('express');
const router = express.Router();

const Node = require('../models/Node');
const Website = require('../models/Website');
const Deployment = require('../models/Deployment');
const { authenticateAdmin, authenticateNode } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const logger = require('../config/logger');
const proxyService = require('../services/proxyService');
const deploymentService = require('../services/deploymentService');
const Command = require('../models/Command');
const { v4: uuidv4 } = require('uuid');

/**
 * POST /api/nodes/:nodeId/drain
 * Drain a node — move all websites to other nodes
 */
router.post('/:nodeId/drain', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const node = await Node.findOne({ nodeId: req.params.nodeId }).lean();
    if (!node) return res.status(404).json({ error: 'Node not found' });

    // Find all active websites on this node
    const websites = await Website.find({
      $or: [
        { activeNode: node._id },
        { primaryNode: node._id },
        { secondaryNode: node._id },
        { fallbackNode: node._id },
      ],
      status: 'active',
    }).lean();

    // Find alternative nodes for reassignment
    const altNodes = await Node.find({
      status: 'online',
      mode: { $in: ['IDLE', 'NORMAL'] },
      nodeId: { $ne: req.params.nodeId },
    }).sort({ score: -1 }).limit(5).lean();

    if (altNodes.length === 0 && websites.length > 0) {
      return res.status(400).json({ error: 'No alternative nodes available for draining' });
    }

    const io = req.app.get('io');
    const evacuatedWebsites = [];

    // For each website on this node, move it to an alternative
    for (let i = 0; i < websites.length; i++) {
      const site = websites[i];
      const altNode = altNodes[i % altNodes.length];
      const altNodeDoc = await Node.findById(altNode._id);
      if (!altNodeDoc) continue;

      // Send stop command to the drained node's agent
      const stopCommandId = uuidv4();
      await Command.create({
        commandId: stopCommandId,
        nodeId: req.params.nodeId,
        command: 'remove_site',
        params: { siteId: site.siteId, domain: site.domain },
        status: 'pending',
        createdBy: req.admin.email,
      });
      if (io) {
        io.to(`node:${req.params.nodeId}`).emit('command:new', {
          commandId: stopCommandId,
          command: 'remove_site',
          params: { siteId: site.siteId, domain: site.domain },
        });
      }

      // Trigger deployment on the alternative node
      const activeDeployment = await Deployment.findOne({
        siteId: site.siteId,
        status: 'active',
      }).sort({ createdAt: -1 }).lean();

      if (activeDeployment) {
        const deployCommandId = uuidv4();
        await Command.create({
          commandId: deployCommandId,
          nodeId: altNode.nodeId,
          command: 'deploy_site',
          params: {
            deploymentId: activeDeployment.deploymentId,
            siteId: site.siteId,
            domain: site.domain,
            artifactPath: activeDeployment.artifactPath,
          },
          status: 'pending',
          createdBy: req.admin.email,
        });
        if (io) {
          io.to(`node:${altNode.nodeId}`).emit('command:new', {
            commandId: deployCommandId,
            command: 'deploy_site',
            params: {
              deploymentId: activeDeployment.deploymentId,
              siteId: site.siteId,
              domain: site.domain,
              artifactPath: activeDeployment.artifactPath,
            },
          });
        }

        // Wait for deployment to complete on target (poll up to 30s)
        const deployConfirmed = await waitForDeploymentConfirmation(activeDeployment.deploymentId, altNode.nodeId, 30000);
        if (!deployConfirmed) {
          logger.warn(`Drain: deployment ${activeDeployment.deploymentId} not confirmed on ${altNode.name}, continuing anyway`);
        }
      }

      // Update website to point to new active node
      await Website.updateOne(
        { _id: site._id },
        {
          $set: {
            activeNode: altNode._id,
            primaryNode: altNode._id,
          },
          $push: {
            failoverHistory: {
              from: node._id,
              to: altNode._id,
              reason: 'Manual drain',
              timestamp: new Date(),
            },
          },
          $pull: {
            assignedNodes: node._id,
          },
          $addToSet: {
            assignedNodes: altNode._id,
          },
        }
      );

      // Update proxy routing to point to the new node
      if (site.domain) {
        await proxyService.registerSite({
          siteId: site.siteId,
          domain: site.domain,
          deploymentId: activeDeployment?.deploymentId || '',
          nodeId: altNode.nodeId,
          nodeName: altNode.name,
          port: activeDeployment?.containerInfo?.exposedPort || 8080,
          targetAddress: altNode.tailscaleIP || altNode.ipAddress,
        });
      }

      evacuatedWebsites.push({ siteId: site.siteId, domain: site.domain, movedTo: altNode.name, confirmed: deployConfirmed || false });
    }

    // Mark node as disabled
    await Node.updateOne({ nodeId: req.params.nodeId }, { $set: { type: 'DISABLED', typeSetByAdmin: true } });

    // Notify admin panel
    if (io) {
      io.to('admin').emit('node:drained', {
        nodeId: req.params.nodeId,
        nodeName: node.name,
        websitesMoved: evacuatedWebsites.length,
      });
    }

    logger.info(`Node ${node.name} drained. ${evacuatedWebsites.length} websites moved.`);

    const succeeded = evacuatedWebsites.filter(w => w.confirmed);
    const partial = evacuatedWebsites.filter(w => !w.confirmed);

    res.json({
      success: partial.length === 0,
      message: partial.length === 0
        ? `Node drained. ${evacuatedWebsites.length} websites moved successfully.`
        : `Node partially drained. ${succeeded.length} moved, ${partial.length} may need manual verification.`,
      websitesMoved: evacuatedWebsites.length,
      websitesConfirmed: succeeded.length,
      alternativeNodes: altNodes.length,
      details: evacuatedWebsites,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Poll for deployment confirmation on a target node.
 * Returns true if the deployment reaches 'active' or 'completed' status within timeout.
 */
async function waitForDeploymentConfirmation(deploymentId, nodeId, timeoutMs) {
  const pollInterval = 1000;
  let waited = 0;

  while (waited < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    waited += pollInterval;

    const dep = await Deployment.findOne({ deploymentId }).lean();
    if (!dep) return false;

    // Check if the specific node's nodeResult is active
    if (dep.nodeResults && Array.isArray(dep.nodeResults)) {
      const nodeResult = dep.nodeResults.find(nr => nr.nodeId === nodeId);
      if (nodeResult && nodeResult.status === 'active') return true;
    }

    // Also check deployment-level status
    if (dep.status === 'active') return true;
    if (dep.status === 'failed') return false;
  }

  return false;
}

/**
 * POST /api/nodes/:nodeId/maintenance
 * Toggle maintenance mode for a node
 */
router.post('/:nodeId/maintenance', authenticateAdmin, async (req, res, next) => {
  try {
    const node = await Node.findOne({ nodeId: req.params.nodeId });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const newType = node.type === 'DISABLED' ? 'TRAFFIC_NODE' : 'DISABLED';
    await Node.updateOne(
      { nodeId: req.params.nodeId },
      { $set: { type: newType, typeSetByAdmin: true } }
    );

    logger.info(`Node ${node.name} ${newType === 'DISABLED' ? 'entered' : 'exited'} maintenance mode`);

    res.json({
      success: true,
      message: `Node ${newType === 'DISABLED' ? 'placed in' : 'removed from'} maintenance mode`,
      type: newType,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
