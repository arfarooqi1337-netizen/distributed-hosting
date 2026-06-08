/**
 * Authentication middleware
 *
 * Supports three authentication modes:
 * 1. Node API key authentication (for agent heartbeats/registration)
 * 2. JWT admin authentication (for dashboard/panel)
 * 3. JWT client authentication (for client portal)
 */

const jwt = require('jsonwebtoken');
const Node = require('../models/Node');
const Client = require('../models/Client');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Authenticate a node using its API key (Bearer token)
 * Used by: /api/nodes/heartbeat, /api/nodes/register
 */
const authenticateNode = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const apiKey = authHeader.split(' ')[1];
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    const node = await Node.findOne({ apiKey });
    if (!node) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Attach node to request
    req.node = node;
    req.nodeId = node.nodeId;
    next();
  } catch (error) {
    logger.error('Node authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

/**
 * Authenticate an admin user using JWT
 * Used by: dashboard API routes
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.error('Admin authentication error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Authenticate a client user using JWT
 * Used by: client portal API routes
 */
const authenticateClient = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== 'client') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    const client = await Client.findOne({ clientId: decoded.clientId });
    if (!client || client.status !== 'active') {
      return res.status(403).json({ error: 'Account not active' });
    }

    req.client = decoded;
    req.clientId = decoded.clientId;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.error('Client authentication error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Role-based access control middleware
 * Checks that the authenticated admin has the required role(s).
 * Use after authenticateAdmin.
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

/**
 * Optional authentication — attaches admin if token present, continues regardless
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded.type === 'client') {
          req.client = decoded;
          req.clientId = decoded.clientId;
        } else {
          req.admin = decoded;
        }
      }
    }
  } catch (e) {
    // Token invalid or expired — continue without auth
  }
  next();
};

module.exports = { authenticateNode, authenticateAdmin, authenticateClient, requireRole, optionalAuth };
