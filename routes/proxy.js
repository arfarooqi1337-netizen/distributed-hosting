/**
 * Proxy routes
 *
 * Management API for the reverse proxy and tunnel system.
 *
 * GET    /api/proxy/status       — Proxy status + routing table
 * POST   /api/proxy/reload       — Force reload proxy config
 * GET    /api/proxy/routes       — List all proxy routes
 * GET    /api/proxy/tunnels      — Node tunnel status
 * POST   /api/proxy/tunnels/:nodeId — Update node tunnel config
 * GET    /api/proxy/instructions/:type — Setup instructions for tunnel type
 */

const express = require('express');
const router = express.Router();

const { authenticateAdmin } = require('../middleware/auth');
const proxyService = require('../services/proxyService');
const tunnelService = require('../services/tunnelService');
const logger = require('../config/logger');

/**
 * GET /api/proxy/status
 * Get proxy service status and routing table
 */
router.get('/status', authenticateAdmin, async (req, res, next) => {
  try {
    const status = proxyService.getProxyStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/proxy/reload
 * Force reload of the proxy configuration
 */
router.post('/reload', authenticateAdmin, async (req, res, next) => {
  try {
    await proxyService.generateCaddyfile();
    await proxyService.reloadCaddy();
    res.json({
      success: true,
      message: 'Proxy configuration reloaded',
      routingTable: proxyService.getRoutingTable(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/proxy/routes
 * List all active proxy routes
 */
router.get('/routes', authenticateAdmin, async (req, res, next) => {
  try {
    const routes = proxyService.getRoutingTable();
    res.json({ success: true, count: routes.length, routes });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/proxy/tunnels
 * Get tunnel status for all nodes
 */
router.get('/tunnels', authenticateAdmin, async (req, res, next) => {
  try {
    const tunnels = await tunnelService.getTunnelStatus();
    res.json({ success: true, count: tunnels.length, tunnels });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/proxy/tunnels/:nodeId
 * Update a node's tunnel endpoint configuration
 */
router.post('/tunnels/:nodeId', authenticateAdmin, async (req, res, next) => {
  try {
    const { tunnelEndpoint, tunnelType } = req.body;
    if (!tunnelEndpoint) {
      return res.status(400).json({ error: 'tunnelEndpoint is required' });
    }

    await tunnelService.updateNodeTunnel(req.params.nodeId, tunnelEndpoint, tunnelType || 'direct');

    logger.info(`Tunnel config updated for node ${req.params.nodeId}: ${tunnelType} ${tunnelEndpoint}`);

    res.json({
      success: true,
      message: 'Tunnel configuration updated',
      nodeId: req.params.nodeId,
      tunnelEndpoint,
      tunnelType: tunnelType || 'direct',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/proxy/instructions/:type
 * Get setup instructions for a tunnel type
 */
router.get('/instructions/:type', authenticateAdmin, async (req, res, next) => {
  try {
    const validTypes = ['wireguard', 'tailscale', 'zerotier', 'direct'];
    const type = req.params.type;
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    }

    const instructions = tunnelService.getTunnelSetupInstructions(type);
    res.json({ success: true, type, instructions });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
