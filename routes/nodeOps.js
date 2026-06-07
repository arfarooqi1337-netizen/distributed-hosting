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

/**
 * POST /api/nodes/:nodeId/drain
 * Drain a node — move all websites to other nodes
 */
router.post('/:nodeId/drain', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const node = await Node.findOne({ nodeId: req.params.nodeId }).lean();
    if (!node) return res.status(404).json({ error: 'Node not found' });

    // Find all active deployments on this node
    const deployments = await Deployment.find({
      assignedNodeId: req.params.nodeId,
      status: 'active',
    }).lean();

    // Find alternative nodes
    const altNodes = await Node.find({
      status: 'online',
      mode: { $in: ['IDLE', 'NORMAL'] },
      nodeId: { $ne: req.params.nodeId },
    }).sort({ score: -1 }).limit(3).lean();

    if (altNodes.length === 0 && deployments.length > 0) {
      return res.status(400).json({ error: 'No alternative nodes available for draining' });
    }

    // Mark node as disabled
    await Node.updateOne({ nodeId: req.params.nodeId }, { $set: { type: 'DISABLED', typeSetByAdmin: true } });

    // Update websites to move off this node
    const siteIds = [...new Set(deployments.map(d => d.siteId))];
    await Website.updateMany(
      { siteId: { $in: siteIds } },
      { $set: { activeNode: null, primaryNode: altNodes[0]?._id || null } }
    );

    logger.info(`Node ${node.name} drained. ${deployments.length} deployments moved.`);

    res.json({
      success: true,
      message: `Node drained. ${deployments.length} deployments affected.`,
      deploymentsMoved: deployments.length,
      alternativeNodes: altNodes.length,
    });
  } catch (error) {
    next(error);
  }
});

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
