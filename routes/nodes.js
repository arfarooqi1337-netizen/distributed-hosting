/**
 * Node routes
 *
 * Handles node registration, heartbeat, status updates, and admin management.
 * POST /api/nodes/register   - Node registration
 * POST /api/nodes/heartbeat  - Heartbeat data
 * GET  /api/nodes            - List all nodes (admin)
 * GET  /api/nodes/:nodeId    - Get single node (admin)
 * PATCH /api/nodes/:nodeId   - Update node type/owner (admin)
 * DELETE /api/nodes/:nodeId  - Remove a node (admin)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const Node = require('../models/Node');
const NodeHistory = require('../models/NodeHistory');
const Command = require('../models/Command');
const config = require('../config');
const { authenticateNode, authenticateAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { validateNodeRegistration, validateHeartbeat } = require('../middleware/validation');
const { processHeartbeat } = require('../services/heartbeatService');
const logger = require('../config/logger');

/**
 * POST /api/nodes/register
 * Register a new node agent with the controller
 * Requires a MASTER_REGISTRATION_KEY (set in .env) to prevent unauthorized registrations.
 * If a nodeId already exists, the registration is rejected — never re-exposes an API key.
 */
router.post('/register', validateNodeRegistration, async (req, res, next) => {
  try {
    // Require master registration key to prevent unauthorized registrations
    const masterKey = config.masterRegistrationKey;
    const providedKey = req.headers['x-registration-key'];
    if (!providedKey || providedKey !== masterKey) {
      return res.status(403).json({ error: 'Invalid or missing registration key' });
    }

    const { nodeId, name, hostname, os_info, hardware_info, ip_address, version } = req.body;

    // Check if node already exists — reject to prevent API key leak
    const existingNode = await Node.findOne({ nodeId });
    if (existingNode) {
      return res.status(409).json({
        error: 'Node ID already registered. If you lost the API key, delete the node from admin panel and re-register.',
      });
    }

    // Generate API key
    const apiKey = Node.generateApiKey();

    const node = await Node.create({
      nodeId,
      name,
      hostname: hostname || name,
      apiKey,
      version: version || '1.0.0',
      ipAddress: ip_address,
      hardware: {
        cpuCoresLogical: hardware_info?.cpu_cores_logical || 0,
        cpuCoresPhysical: hardware_info?.cpu_cores_physical || 0,
        ramTotalBytes: hardware_info?.ram_total_bytes || 0,
        diskTotalBytes: hardware_info?.disk_total_bytes || 0,
        os: os_info?.system || '',
        processor: os_info?.processor || '',
      },
      firstSeen: new Date(),
      lastSeen: new Date(),
    });

    logger.info(`Node registered: ${name} (${nodeId})`);

    res.status(201).json({
      success: true,
      nodeId: node.nodeId,
      apiKey,
      message: 'Node registered successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/nodes/heartbeat
 * Receive heartbeat data from an agent.
 * Auth: Node API key (Bearer) — the node is identified by its API key, NOT the body nodeId.
 *       The body nodeId is ignored for security (prevents impersonation).
 */
router.post('/heartbeat', authenticateNode, async (req, res, next) => {
  try {
    const io = req.app.get('io');
    // Use the authenticated node, ignore any nodeId in the body for security
    await processHeartbeat(req.node, req.body, io);

    res.json({
      success: true,
      message: 'Heartbeat received',
      serverTime: Date.now(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/nodes
 * List all registered nodes (admin) with pagination
 * Auth: JWT admin
 * Query: status, type, mode, sort, limit, offset
 */
router.get('/', authenticateAdmin, async (req, res, next) => {
  try {
    const { status, type, mode, sort, limit, offset } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (mode) filter.mode = mode;

    let sortOption = { lastSeen: -1 };
    if (sort === 'score') sortOption = { score: -1 };
    if (sort === 'name') sortOption = { name: 1 };

    const parseNum = (val, def) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? def : Math.min(Math.max(n, 0), 500);
    };

    const limitNum = parseNum(limit, 100);
    const offsetNum = parseNum(offset, 0);

    const [nodes, total] = await Promise.all([
      Node.find(filter).sort(sortOption).skip(offsetNum).limit(limitNum).lean(),
      Node.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: nodes.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      nodes,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/nodes/:nodeId
 * Get a single node by nodeId
 * Auth: JWT admin
 */
router.get('/:nodeId', authenticateAdmin, async (req, res, next) => {
  try {
    const node = await Node.findOne({ nodeId: req.params.nodeId }).lean();
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    res.json({ success: true, node });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/nodes/:nodeId
 * Update a node (type, owner, etc.)
 * Auth: JWT admin
 */
router.patch('/:nodeId', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { type, owner, name } = req.body;
    const updateFields = {};
    const oldValues = {};

    if (type) {
      const validTypes = ['TRAFFIC_NODE', 'COMPUTE_NODE', 'BACKUP_NODE', 'DISABLED'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }
      // Fetch current node for audit log
      const current = await Node.findOne({ nodeId: req.params.nodeId }).lean();
      if (current) oldValues.type = current.type;
      updateFields.type = type;
      updateFields.typeSetByAdmin = true;
    }
    if (owner) updateFields.owner = owner;
    if (name) updateFields.name = name;

    const node = await Node.findOneAndUpdate(
      { nodeId: req.params.nodeId },
      { $set: updateFields },
      { new: true }
    ).lean();

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // Audit log
    if (type) {
      await res.auditLog('node_type_changed', 'node', node.nodeId, { from: oldValues.type, to: type });
    }
    if (owner) {
      await res.auditLog('node_owner_changed', 'node', node.nodeId, { to: owner });
    }

    // Emit update
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('node:update', {
        nodeId: node.nodeId,
        name: node.name,
        type: node.type,
        owner: node.owner,
      });
    }

    res.json({ success: true, node });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/nodes/:nodeId
 * Remove a node from the system
 * Auth: JWT admin
 */
router.delete('/:nodeId', authenticateAdmin, async (req, res, next) => {
  try {
    const node = await Node.findOneAndDelete({ nodeId: req.params.nodeId });
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    logger.info(`Node removed: ${node.name} (${node.nodeId})`);

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('node:removed', { nodeId: node.nodeId });
    }

    res.json({ success: true, message: 'Node removed' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/nodes/commands/poll
 * Poll for pending commands assigned to this node.
 * Auth: Node API key (Bearer)
 */
router.post('/commands/poll', authenticateNode, async (req, res, next) => {
  try {
    const commands = await Command.find({
      nodeId: req.node.nodeId,
      status: { $in: ['pending', 'dispatched'] },
    })
      .sort({ createdAt: 1 })
      .limit(10)
      .lean();

    // Mark as dispatched
    if (commands.length > 0) {
      await Command.updateMany(
        { commandId: { $in: commands.map((c) => c.commandId) } },
        { $set: { status: 'dispatched', dispatchedAt: new Date() } }
      );
    }

    res.json({ success: true, commands });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/nodes/commands/ack
 * Acknowledge command completion / report result.
 * Auth: Node API key (Bearer)
 */
router.post('/commands/ack', authenticateNode, async (req, res, next) => {
  try {
    const { commandId, result } = req.body;
    if (!commandId) {
      return res.status(400).json({ error: 'commandId is required' });
    }

    const command = await Command.findOneAndUpdate(
      { commandId, nodeId: req.node.nodeId },
      {
        $set: {
          status: result?.status === 'error' ? 'failed' : 'completed',
          result: result || {},
          completedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!command) {
      return res.status(404).json({ error: 'Command not found for this node' });
    }

    res.json({ success: true, command });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/nodes/:nodeId/history
 * Get historical metrics for a node
 * Auth: JWT admin
 * Query: range (1h, 6h, 24h, 7d, 30d)
 */
router.get('/:nodeId/history', authenticateAdmin, async (req, res, next) => {
  try {
    const { range = '1h' } = req.query;

    const rangeMap = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };

    const duration = rangeMap[range] || rangeMap['1h'];
    const since = new Date(Date.now() - duration);

    // Sample data points - for longer ranges, return fewer points
    let limit = 180; // max data points
    if (range === '7d') limit = 500;
    if (range === '30d') limit = 1000;

    const history = await NodeHistory.find({
      nodeId: req.params.nodeId,
      timestamp: { $gte: since },
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      count: history.length,
      range,
      history: history.reverse(), // chronological order
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
