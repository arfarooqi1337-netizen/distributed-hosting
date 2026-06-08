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
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const Client = require('../models/Client');
const Project = require('../models/Project');
const Website = require('../models/Website');
const Deployment = require('../models/Deployment');
const config = require('../config');
const { authenticateAdmin, authenticateClient } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const logger = require('../config/logger');

/**
 * POST /api/clients/login
 * Client login — returns JWT token
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const client = await Client.findOne({ email: email.toLowerCase() });
    if (!client) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (client.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // Validate password
    if (!client.password) {
      return res.status(401).json({ error: 'No password set. Contact admin for setup.' });
    }
    const valid = await bcrypt.compare(password, client.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await Client.updateOne(
      { clientId: client.clientId },
      { $set: { lastLoginAt: new Date(), lastLoginIp: req.ip } }
    );

    const token = jwt.sign(
      { clientId: client.clientId, email: client.email, name: client.name, type: 'client' },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    logger.info(`Client logged in: ${email}`);
    res.json({
      success: true,
      token,
      client: {
        clientId: client.clientId,
        email: client.email,
        name: client.name,
        plan: client.plan,
        status: client.status,
        limits: client.limits,
        usage: client.usage,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/clients/me
 * Get the authenticated client's own profile, projects, and websites
 */
router.get('/me', authenticateClient, async (req, res, next) => {
  try {
    const client = await Client.findOne({ clientId: req.clientId }).lean();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const projects = await Project.find({ clientId: req.clientId }).sort({ createdAt: -1 }).lean();
    const websites = await Website.find({ clientId: req.clientId }).sort({ createdAt: -1 }).lean();

    res.json({
      success: true,
      client: {
        clientId: client.clientId,
        email: client.email,
        name: client.name,
        company: client.company,
        plan: client.plan,
        status: client.status,
        limits: client.limits,
        usage: client.usage,
        createdAt: client.createdAt,
      },
      projects,
      websites,
    });
  } catch (error) {
    next(error);
  }
});

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
