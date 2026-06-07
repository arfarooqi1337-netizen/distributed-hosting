/**
 * Authentication middleware
 *
 * Supports two authentication modes:
 * 1. Node API key authentication (for agent heartbeats/registration)
 * 2. JWT admin authentication (for dashboard/panel)
 */

const jwt = require('jsonwebtoken');
const Node = require('../models/Node');
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

module.exports = { authenticateNode, authenticateAdmin };
