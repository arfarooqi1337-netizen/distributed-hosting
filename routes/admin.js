/**
 * Admin routes
 *
 * Authentication, dashboard stats, and system management.
 * POST /api/admin/login    - Admin login (returns JWT)
 * GET  /api/admin/stats    - Dashboard aggregated stats
 * GET  /api/admin/alerts   - System alerts
 * PATCH /api/admin/alerts/:alertId - Acknowledge alert
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const Admin = require('../models/Admin');
const Alert = require('../models/Alert');
const Command = require('../models/Command');
const DashboardStats = require('../models/DashboardStats');
const AuditLog = require('../models/AuditLog');
const config = require('../config');
const { authenticateAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const logger = require('../config/logger');

// Stricter rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMax,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP + email combination to prevent brute force across accounts
    return `${req.ip}_${req.body?.email || 'unknown'}`;
  },
});

/**
 * POST /api/admin/login
 * Authenticate admin and return JWT token
 * Rate limited: 10 attempts per 15 minutes per IP
 */
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email, role: admin.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      success: true,
      token,
      admin: {
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/stats
 * Get cached dashboard statistics
 */
router.get('/stats', authenticateAdmin, async (req, res, next) => {
  try {
    let stats = await DashboardStats.findOne({ key: 'global' }).lean();

    if (!stats) {
      // Return empty stats
      stats = {
        totalNodes: 0,
        onlineNodes: 0,
        offlineNodes: 0,
        gamingNodes: 0,
        trafficNodes: 0,
        computeNodes: 0,
        backupNodes: 0,
        disabledNodes: 0,
        avgCpuUsage: 0,
        avgRamUsage: 0,
        totalUploadMbps: 0,
        totalDownloadMbps: 0,
        activeWebsites: 0,
        pendingJobs: 0,
        runningJobs: 0,
        unacknowledgedAlerts: 0,
      };
    }

    res.json({ success: true, stats });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/alerts
 * Get system alerts with pagination
 */
router.get('/alerts', authenticateAdmin, async (req, res, next) => {
  try {
    const { type, severity, acknowledged, limit = 50, offset = 0 } = req.query;
    const filter = {};

    if (type) filter.type = type;
    if (severity) filter.severity = severity;
    if (acknowledged !== undefined) filter.acknowledged = acknowledged === 'true';

    const alerts = await Alert.find(filter)
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .lean();

    const total = await Alert.countDocuments(filter);

    res.json({ success: true, count: alerts.length, total, alerts });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/alerts/:alertId
 * Acknowledge an alert
 */
router.patch('/alerts/:alertId', authenticateAdmin, async (req, res, next) => {
  try {
    const alert = await Alert.findOneAndUpdate(
      { alertId: req.params.alertId },
      {
        $set: {
          acknowledged: true,
          acknowledgedBy: req.admin.email,
          acknowledgedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ success: true, alert: alert.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/commands
 * Dispatch a command to a node.
 * Body: { nodeId, command, params }
 */
router.post('/commands', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { nodeId, command, params } = req.body;
    if (!nodeId || !command) {
      return res.status(400).json({ error: 'nodeId and command are required' });
    }

    const commandId = require('uuid').v4();
    const cmd = await Command.create({
      commandId,
      nodeId,
      command,
      params: params || {},
      status: 'pending',
      createdBy: req.admin.email,
    });

    // Notify the node via Socket.IO if connected
    const io = req.app.get('io');
    if (io) {
      io.to(`node:${nodeId}`).emit('command:new', {
        commandId: cmd.commandId,
        command: cmd.command,
        params: cmd.params,
      });
    }

    logger.info(`Command dispatched: ${command} -> ${nodeId} (id=${commandId})`);

    res.status(201).json({ success: true, command: cmd.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/commands
 * List commands with optional filters.
 * Query: nodeId, status, limit, offset
 */
router.get('/commands', authenticateAdmin, async (req, res, next) => {
  try {
    const { nodeId, status, limit = 50, offset = 0 } = req.query;
    const filter = {};
    if (nodeId) filter.nodeId = nodeId;
    if (status) filter.status = status;

    const commands = await Command.find(filter)
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .lean();

    const total = await Command.countDocuments(filter);

    res.json({ success: true, count: commands.length, total, commands });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/change-password
 * Change the current admin's password
 * Auth: JWT admin
 */
router.post('/change-password', authenticateAdmin, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Validate new password strength
    if (!Admin.validatePasswordStrength(newPassword)) {
      return res.status(400).json({
        error: 'Password must be at least 12 characters with uppercase, lowercase, digit, and special character',
      });
    }

    const admin = await Admin.findOne({ email: req.admin.email });
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const isMatch = await require('bcryptjs').compare(currentPassword, admin.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    admin.password = newPassword;
    admin.mustChangePassword = false;
    await admin.save();

    logger.info(`Password changed for admin: ${req.admin.email}`);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/users
 * List all admin users
 * Auth: JWT superadmin
 */
router.get('/users', authenticateAdmin, async (req, res, next) => {
  try {
    // Only superadmin can list users
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can manage users' });
    }

    const users = await Admin.find({}).select('email role name lastLogin isActive createdAt').lean();

    res.json({ success: true, count: users.length, users });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/users
 * Create a new admin user
 * Auth: JWT superadmin
 */
router.post('/users', authenticateAdmin, async (req, res, next) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can create users' });
    }

    const { email, password, role, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!Admin.validatePasswordStrength(password)) {
      return res.status(400).json({
        error: 'Password must be at least 12 characters with uppercase, lowercase, digit, and special character',
      });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Admin with this email already exists' });
    }

    const admin = await Admin.create({
      email,
      password,
      role: role || 'admin',
      name: name || 'Admin',
      mustChangePassword: true,
    });

    logger.info(`Admin user created: ${email} (role: ${role || 'admin'})`);

    res.status(201).json({
      success: true,
      admin: {
        email: admin.email,
        role: admin.role,
        name: admin.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/users/:email
 * Update an admin user (role, isActive)
 * Auth: JWT superadmin
 */
router.patch('/users/:email', authenticateAdmin, async (req, res, next) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can manage users' });
    }

    const { role, isActive } = req.body;
    const updateFields = {};

    if (role) {
      const validRoles = ['admin', 'superadmin'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updateFields.role = role;
    }
    if (isActive !== undefined) updateFields.isActive = isActive;

    const admin = await Admin.findOneAndUpdate(
      { email: req.params.email.toLowerCase() },
      { $set: updateFields },
      { new: true }
    ).select('email role name isActive');

    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    logger.info(`Admin user updated: ${req.params.email}`);

    res.json({ success: true, admin });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
