/**
 * Client management routes
 *
 * Foundation for the future client portal.
 * Basic CRUD for client accounts.
 *
 * Future expansion: client login, project management,
 * domain management, billing, usage limits.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const Client = require('../models/Client');
const Project = require('../models/Project');
const { authenticateAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const logger = require('../config/logger');

/**
 * GET /api/clients
 * List all clients (admin only)
 */
router.get('/', authenticateAdmin, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const parseNum = (v, d) => { const n = parseInt(v); return isNaN(n) ? d : Math.min(Math.max(n, 0), 500); };
    const limitNum = parseNum(limit, 50);
    const offsetNum = parseNum(offset, 0);

    const [clients, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1 }).skip(offsetNum).limit(limitNum).lean(),
      Client.countDocuments(filter),
    ]);

    res.json({ success: true, count: clients.length, total, clients });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/clients
 * Create a new client account
 */
router.post('/', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { email, name, company, plan } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    const existing = await Client.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Client with this email already exists' });
    }

    const client = await Client.create({
      clientId: `client_${uuidv4().split('-')[0]}`,
      email: email.toLowerCase(),
      name,
      company: company || '',
      plan: plan || 'free',
      status: 'active',
    });

    await res.auditLog('client_created', 'admin', client.clientId, { email, name, plan });

    logger.info(`Client created: ${email} (${client.clientId})`);
    res.status(201).json({ success: true, client: client.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/clients/:clientId
 * Get client details with their projects
 */
router.get('/:clientId', authenticateAdmin, async (req, res, next) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId }).lean();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const projects = await Project.find({ clientId: client.clientId }).sort({ createdAt: -1 }).lean();

    res.json({ success: true, client, projects });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/clients/:clientId
 * Update client details
 */
router.patch('/:clientId', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { name, company, plan, status, notes } = req.body;
    const update = {};
    if (name) update.name = name;
    if (company !== undefined) update.company = company;
    if (plan) update.plan = plan;
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;

    const client = await Client.findOneAndUpdate(
      { clientId: req.params.clientId },
      { $set: update },
      { new: true }
    ).lean();

    if (!client) return res.status(404).json({ error: 'Client not found' });

    res.json({ success: true, client });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
