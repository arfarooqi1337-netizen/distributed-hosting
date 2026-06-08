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
const { authenticateAdmin, optionalAuth } = require('../middleware/auth');
const { validateCreateWebsite } = require('../middleware/validation');
const logger = require('../config/logger');
const storageService = require('../services/storageService');

/**
 * GET /api/websites
 * List all websites (admin sees all, client sees own)
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = {};

    // Client scope: only see own websites
    if (req.clientId) {
      filter.clientId = req.clientId;
    } else if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (status) filter.status = status;

    const websites = await Website.find(filter)
      .populate('assignedNodes', 'nodeId name status mode metrics.cpuPercent metrics.ramPercent score')
      .populate('primaryNode', 'nodeId name status score')
      .populate('secondaryNode', 'nodeId name status score')
      .populate('fallbackNode', 'nodeId name status score')
      .populate('activeNode', 'nodeId name status score tailscaleIP ipAddress')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: websites.length, websites });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/websites
 * Create a new website (admin or client)
 */
router.post('/', optionalAuth, validateCreateWebsite, async (req, res, next) => {
  try {
    const { domain, type, assignedNodeIds, source, clientId } = req.body;

    // Authorization: admin can create for any client, client can create own
    let ownerClientId = null;
    if (req.clientId) {
      ownerClientId = req.clientId;
    } else if (req.admin) {
      ownerClientId = clientId || null;
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

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
      clientId: ownerClientId,
      assignedNodes: nodes.map((n) => n._id),
      primaryNode,
    });

    logger.info(`Website created: ${domain} (${siteId}) by client=${ownerClientId || 'admin'}`);

    res.status(201).json({ success: true, website: website.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/websites/:siteId
 * Get website details (admin sees all, client sees own)
 */
router.get('/:siteId', optionalAuth, async (req, res, next) => {
  try {
    const website = await Website.findOne({ siteId: req.params.siteId })
      .populate('assignedNodes', 'nodeId name status mode metrics score')
      .populate('primaryNode', 'nodeId name status score')
      .populate('secondaryNode', 'nodeId name status score')
      .populate('fallbackNode', 'nodeId name status score')
      .populate('activeNode', 'nodeId name status score tailscaleIP ipAddress')
      .lean();

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    // Client scope: only own websites
    if (req.clientId && website.clientId !== req.clientId) {
      return res.status(403).json({ error: 'Access denied' });
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
    const { type, status, assignedNodeIds, source, activeNodeId, primaryNodeId, secondaryNodeId, fallbackNodeId } = req.body;
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

    // Node assignment updates — resolve nodeId to _id
    for (const [field, nodeId] of [['activeNode', activeNodeId], ['primaryNode', primaryNodeId], ['secondaryNode', secondaryNodeId], ['fallbackNode', fallbackNodeId]]) {
      if (nodeId !== undefined) {
        if (nodeId) {
          const node = await Node.findOne({ nodeId }).select('_id').lean();
          if (node) updateFields[field] = node._id;
          else return res.status(400).json({ error: `Node ${nodeId} not found` });
        } else {
          updateFields[field] = null;
        }
      }
    }

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

/**
 * POST /api/websites/:siteId/domains
 * Add a custom domain to a website
 */
router.post('/:siteId/domains', authenticateAdmin, async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    const website = await Website.findOne({ siteId: req.params.siteId });
    if (!website) return res.status(404).json({ error: 'Website not found' });

    const domainLower = domain.toLowerCase().trim();
    if (website.customDomains && website.customDomains.includes(domainLower)) {
      return res.status(409).json({ error: 'Domain already added' });
    }

    website.customDomains = [...(website.customDomains || []), domainLower];
    await website.save();

    // Regenerate Caddyfile to include new domain
    const proxyService = require('../services/proxyService');
    proxyService.generateCaddyfile().catch(() => {});
    proxyService.reloadCaddy().catch(() => {});

    res.json({ success: true, customDomains: website.customDomains });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/websites/:siteId/domains/:domain
 * Remove a custom domain from a website
 */
router.delete('/:siteId/domains/:domain', authenticateAdmin, async (req, res, next) => {
  try {
    const website = await Website.findOne({ siteId: req.params.siteId });
    if (!website) return res.status(404).json({ error: 'Website not found' });

    website.customDomains = (website.customDomains || []).filter(
      d => d !== req.params.domain.toLowerCase()
    );
    await website.save();

    const proxyService = require('../services/proxyService');
    proxyService.generateCaddyfile().catch(() => {});
    proxyService.reloadCaddy().catch(() => {});

    res.json({ success: true, customDomains: website.customDomains });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/websites/:siteId/files
 * List files in the deployed website's extracted directory
 */
router.get('/:siteId/files', authenticateAdmin, async (req, res, next) => {
  try {
    const path = require('path');
    const fs = require('fs');
    const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

    // Find the latest deployment (active or failed — files may still be accessible)
    const deployment = await require('../models/Deployment').findOne({
      siteId: req.params.siteId,
    }).sort({ createdAt: -1 }).lean();

    if (!deployment) return res.status(404).json({ error: 'No deployment found for this site' });

    const extractDir = path.join(DEPLOYMENTS_DIR, deployment.deploymentId, 'extracted');
    const subdir = req.query.path || '';

    // If not extracted yet, try to download artifact from storage and extract
    if (!fs.existsSync(extractDir)) {
      try {
        const artifactInfo = storageService.getArtifactInfo(deployment);
        const zipPath = await storageService.getArtifactPath(deployment.deploymentId, artifactInfo);
        await storageService.extractArchive(deployment.deploymentId, zipPath);
      } catch (err) {
        logger.warn(`File manager: could not retrieve artifact for ${deployment.deploymentId}: ${err.message}`);
        return res.json({ files: [], path: subdir, extracted: false, error: 'Artifact not available. Files may only be accessible on the hosting node.' });
      }
    }

    if (!fs.existsSync(extractDir)) {
      return res.json({ files: [], path: subdir, extracted: false });
    }

    const targetPath = path.join(extractDir, subdir);
    // Security: prevent directory traversal
    if (!targetPath.startsWith(extractDir)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const files = entries.map(e => {
        const fullPath = path.join(targetPath, e.name);
        const s = fs.statSync(fullPath);
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: s.size,
          modified: s.mtime,
        };
      }).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return res.json({ files, path: subdir, extracted: true });
    }

    // Return single file
    const content = fs.readFileSync(targetPath, 'utf-8');
    res.json({ files: [{ name: path.basename(targetPath), type: 'file', size: stat.size, content }], path: subdir, extracted: true });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/websites/:siteId/files
 * Save a file in the deployed website
 */
router.put('/:siteId/files', authenticateAdmin, async (req, res, next) => {
  try {
    const path = require('path');
    const fs = require('fs');
    const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

    const { filePath: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'filePath is required' });

    // Find latest deployment (any status)
    const deployment = await require('../models/Deployment').findOne({
      siteId: req.params.siteId,
    }).sort({ createdAt: -1 }).lean();

    if (!deployment) return res.status(404).json({ error: 'No deployment found for this site' });

    const extractDir = path.join(DEPLOYMENTS_DIR, deployment.deploymentId, 'extracted');

    // Ensure files are available locally
    if (!fs.existsSync(extractDir)) {
      try {
        const artifactInfo = storageService.getArtifactInfo(deployment);
        const zipPath = await storageService.getArtifactPath(deployment.deploymentId, artifactInfo);
        await storageService.extractArchive(deployment.deploymentId, zipPath);
      } catch (err) {
        return res.status(503).json({ error: 'Artifact not available locally. Cannot save files.' });
      }
    }

    const targetPath = path.join(extractDir, relPath);

    if (!targetPath.startsWith(extractDir)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');

    logger.info(`File saved: ${relPath} for site ${req.params.siteId}`);
    res.json({ success: true, path: relPath });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/websites/:siteId/env-vars
 * List environment variables for a website (values masked for clients)
 */
router.get('/:siteId/env-vars', optionalAuth, async (req, res, next) => {
  try {
    const website = await Website.findOne({ siteId: req.params.siteId }).lean();
    if (!website) return res.status(404).json({ error: 'Website not found' });

    // Client scope check
    if (req.clientId && website.clientId !== req.clientId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Mask values for non-admin users
    const isAdmin = !!req.admin;
    const vars = (website.environmentVariables || []).map(v => ({
      key: v.key,
      value: isAdmin ? v.value : '••••••••',
    }));

    res.json({ success: true, variables: vars });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/websites/:siteId/env-vars
 * Set environment variables (replaces all)
 */
router.put('/:siteId/env-vars', optionalAuth, async (req, res, next) => {
  try {
    const { variables } = req.body;
    if (!Array.isArray(variables)) {
      return res.status(400).json({ error: 'variables must be an array of { key, value }' });
    }

    const website = await Website.findOne({ siteId: req.params.siteId });
    if (!website) return res.status(404).json({ error: 'Website not found' });

    // Client scope check
    if (req.clientId && website.clientId !== req.clientId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    website.environmentVariables = variables.map(v => ({
      key: v.key.trim(),
      value: v.value,
    }));
    await website.save();

    logger.info(`Environment variables updated for site ${req.params.siteId}`);
    res.json({ success: true, variables: website.environmentVariables });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/websites/:siteId/verify-domain
 * Verify DNS points to the main VPS
 */
router.post('/:siteId/verify-domain', optionalAuth, async (req, res, next) => {
  try {
    const website = await Website.findOne({ siteId: req.params.siteId }).lean();
    if (!website) return res.status(404).json({ error: 'Website not found' });

    // Client scope check
    if (req.clientId && website.clientId !== req.clientId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dns = require('dns').promises;
    const VPS_PUBLIC_IP = '13.250.17.15';
    const results = [];

    // Check main domain
    try {
      const addresses = await dns.resolve4(website.domain);
      const matches = addresses.includes(VPS_PUBLIC_IP);
      results.push({
        domain: website.domain,
        type: 'A',
        expected: VPS_PUBLIC_IP,
        resolved: addresses,
        match: matches,
      });
    } catch (e) {
      results.push({ domain: website.domain, type: 'A', error: e.message, match: false });
    }

    // Check custom domains
    for (const customDomain of (website.customDomains || [])) {
      try {
        const addresses = await dns.resolve4(customDomain);
        const matches = addresses.includes(VPS_PUBLIC_IP);
        results.push({
          domain: customDomain,
          type: 'A',
          expected: VPS_PUBLIC_IP,
          resolved: addresses,
          match: matches,
        });
      } catch (e) {
        results.push({ domain: customDomain, type: 'A', error: e.message, match: false });
      }
    }

    // Check HTTP reachability (port 80)
    const http = require('http');
    const httpResults = [];
    for (const entry of results) {
      if (!entry.match && !entry.error) continue;
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(`http://${entry.domain}`, (res) => {
            httpResults.push({ domain: entry.domain, statusCode: res.statusCode, reachable: true });
            resolve();
          });
          req.on('error', () => {
            httpResults.push({ domain: entry.domain, reachable: false });
            resolve();
          });
          req.setTimeout(5000, () => { req.destroy(); resolve(); });
        });
      } catch (e) {
        httpResults.push({ domain: entry.domain, reachable: false, error: e.message });
      }
    }

    const allMatch = results.every(r => r.match);
    res.json({
      success: true,
      verified: allMatch,
      dns: results,
      http: httpResults,
      message: allMatch
        ? 'DNS is correctly configured'
        : 'DNS is not pointing to the main VPS IP. Add an A record pointing to ' + VPS_PUBLIC_IP,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
