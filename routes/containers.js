/**
 * Container management routes
 *
 * Operations layer for managing Docker containers on nodes.
 * Allows the admin panel to query container status, logs,
 * and perform lifecycle actions (restart, stop, start).
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const Command = require('../models/Command');
const Website = require('../models/Website');
const { authenticateAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const logger = require('../config/logger');

/**
 * GET /api/containers/:nodeId
 * List all containers running on a specific node
 */
router.get('/:nodeId', authenticateAdmin, async (req, res, next) => {
  try {
    const deployments = await Deployment.find({
      assignedNodeId: req.params.nodeId,
      status: { $in: ['active', 'dispatching', 'downloading', 'building', 'deploying'] },
    })
      .sort({ createdAt: -1 })
      .select('deploymentId domain version status progress containerInfo')
      .lean();

    const websiteIds = [...new Set(deployments.map(d => d.siteId))];
    const websites = await Website.find({ siteId: { $in: websiteIds } })
      .select('siteId domain status healthStatus primaryNode')
      .lean();

    const siteMap = {};
    websites.forEach(w => { siteMap[w.siteId] = w; });

    const containers = deployments.map(d => ({
      ...d,
      website: siteMap[d.siteId] || null,
    }));

    res.json({ success: true, count: containers.length, nodeId: req.params.nodeId, containers });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/containers/:nodeId/action
 * Send a container lifecycle action to a node (restart, stop, start, pause, resume)
 * Body: { containerId, action, deploymentId }
 */
router.post('/:nodeId/action', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { containerId, action, deploymentId } = req.body;
    if (!action) return res.status(400).json({ error: 'Action is required' });
    if (!containerId && ['stop','restart'].includes(action)) return res.status(400).json({ error: 'containerId is required for stop/restart actions' });

    const commandName = action === 'restart' ? 'restart_container' :
                        action === 'stop' ? 'stop_container' :
                        action === 'start' ? 'start_container' :
                        action === 'pause' ? 'pause_workload' :
                        action === 'resume' ? 'resume_workload' : null;

    if (!commandName) {
      return res.status(400).json({ error: `Invalid action. Valid: restart, stop, start, pause, resume` });
    }

    const commandId = uuidv4();
    await Command.create({
      commandId,
      nodeId: req.params.nodeId,
      command: commandName,
      params: { container_id: containerId || '', container_name: '', deploymentId: deploymentId || '' },
      status: 'pending',
      createdBy: req.admin.email,
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`node:${req.params.nodeId}`).emit('command:new', {
        commandId,
        command: commandName,
        params: { container_id: containerId || '' },
      });
    }

    logger.info(`Container action dispatched: ${action} on node ${req.params.nodeId}`);
    await res.auditLog('container_action', 'node', req.params.nodeId, { action, containerId, deploymentId });

    // Notify admin panel
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('container:action', { nodeId: req.params.nodeId, action, containerId, deploymentId, commandId });
    }

    res.json({ success: true, message: `Action '${action}' dispatched to node`, commandId });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/containers/:nodeId/logs
 * Request container logs from a node
 */
router.post('/:nodeId/logs', authenticateAdmin, async (req, res, next) => {
  try {
    const { containerId } = req.body;
    if (!containerId) return res.status(400).json({ error: 'containerId is required' });

    const commandId = uuidv4();
    await Command.create({
      commandId,
      nodeId: req.params.nodeId,
      command: 'get_container_logs',
      params: { container_id: containerId, tail: 200 },
      status: 'pending',
      createdBy: req.admin.email,
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`node:${req.params.nodeId}`).emit('command:new', {
        commandId,
        command: 'get_container_logs',
        params: { container_id: containerId, tail: 200 },
      });
    }

    res.json({ success: true, message: 'Log request dispatched', commandId });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
