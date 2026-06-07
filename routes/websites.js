/**
 * Website routes
 *
 * Manage websites/deployments on the hosting platform.
 * GET    /api/websites         - List all websites
 * POST   /api/websites         - Create a new website deployment
 * GET    /api/websites/:siteId - Get website details
 * PATCH  /api/websites/:siteId - Update website
 * DELETE /api/websites/:siteId - Remove website
 * POST   /api/websites/:siteId/deploy - Trigger deployment
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const Website = require('../models/Website');
const Node = require('../models/Node');
const { authenticateAdmin } = require('../middleware/auth');
const { validateCreateWebsite } = require('../middleware/validation');
const logger = require('../config/logger');

/**
 * GET /api/websites
 * List all websites
 */
router.get('/', authenticateAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const websites = await Website.find(filter)
      .populate('assignedNodes', 'nodeId name status mode metrics.cpuPercent metrics.ramPercent score')
      .populate('primaryNode', 'nodeId name status score')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: websites.length, websites });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/websites
 * Create a new website deployment
 */
router.post('/', authenticateAdmin, validateCreateWebsite, async (req, res, next) => {
  try {
    const { domain, type, assignedNodeIds, source } = req.body;

    // Check for duplicate domain
    const existing = await Website.findOne({ domain });
    if (existing) {
      return res.status(409).json({ error: `Domain ${domain} is already registered` });
    }

    // Verify assigned nodes exist
    const nodes = await Node.find({ nodeId: { $in: assignedNodeIds || [] } });
    if (assignedNodeIds && nodes.length !== assignedNodeIds.length) {
      return res.status(400).json({ error: 'One or more assigned nodes not found' });
    }

    // Find best primary node
    let primaryNode = null;
    const trafficNodes = await Node.find({
      type: 'TRAFFIC_NODE',
      status: 'online',
      mode: { $in: ['IDLE', 'NORMAL'] },
    }).sort({ score: -1 }).limit(1);

    if (trafficNodes.length > 0) {
      primaryNode = trafficNodes[0]._id;
    }

    const siteId = `site_${uuidv4().split('-')[0]}`;

    const website = await Website.create({
      siteId,
      domain,
      type: type || 'static',
      status: 'deploying',
      source: source || {},
      assignedNodes: nodes.map((n) => n._id),
      primaryNode,
    });

    logger.info(`Website created: ${domain} (${siteId})`);

    res.status(201).json({ success: true, website: website.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/websites/:siteId
 * Get website details
 */
router.get('/:siteId', authenticateAdmin, async (req, res, next) => {
  try {
    const website = await Website.findOne({ siteId: req.params.siteId })
      .populate('assignedNodes', 'nodeId name status mode metrics score')
      .populate('primaryNode', 'nodeId name status score')
      .lean();

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    res.json({ success: true, website });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/websites/:siteId
 * Update website configuration
 */
router.patch('/:siteId', authenticateAdmin, async (req, res, next) => {
  try {
    const { type, status, assignedNodeIds, source } = req.body;
    const updateFields = {};

    if (type) updateFields.type = type;
    if (status) {
      const validStatuses = ['active', 'paused', 'failed', 'removed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status` });
      }
      updateFields.status = status;
    }
    if (assignedNodeIds) {
      const nodes = await Node.find({ nodeId: { $in: assignedNodeIds } });
      updateFields.assignedNodes = nodes.map((n) => n._id);
    }
    if (source) updateFields.source = { ...source };

    const website = await Website.findOneAndUpdate(
      { siteId: req.params.siteId },
      { $set: updateFields },
      { new: true }
    ).lean();

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    res.json({ success: true, website });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/websites/:siteId
 * Remove a website deployment
 */
router.delete('/:siteId', authenticateAdmin, async (req, res, next) => {
  try {
    const website = await Website.findOneAndUpdate(
      { siteId: req.params.siteId },
      { $set: { status: 'removed' } },
      { new: true }
    );

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    logger.info(`Website removed: ${website.domain} (${website.siteId})`);
    res.json({ success: true, message: 'Website removed' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
