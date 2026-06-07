/**
 * Reverse Proxy Service
 *
 * Manages a Caddy reverse proxy that routes internet traffic
 * to websites hosted on community nodes.
 *
 * Two modes:
 *   1. Port mode (local dev) — Each site gets a unique port, Caddy maps domains
 *   2. Domain mode (production VPS) — Caddy on port 80/443, auto TLS
 *
 * Architecture:
 *   Internet → Caddy (VPS) → WireGuard tunnel → Node Docker container
 *
 * The controller generates and maintains a Caddyfile based on active
 * deployments, and signals Caddy to reload when config changes.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const Website = require('../models/Website');
const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const logger = require('../config/logger');
const config = require('../config');
const tunnelService = require('./tunnelService');

const CADDYFILE_PATH = path.join(__dirname, '..', 'Caddyfile');
const CADDY_DATA_DIR = path.join(__dirname, '..', 'caddy_data');

// Resolve Caddy binary path from config or default
const CADDY_BIN = config.proxy?.caddyPath || 'caddy';

// In-memory routing table: domain → { nodeId, nodeName, port, siteId }
const routingTable = new Map();

let caddyProcess = null;
let proxyEnabled = false;

/**
 * Initialize the proxy service.
 * Checks if Caddy is available, loads existing routes, starts Caddy.
 */
async function initProxy() {
  // Check if Caddy is installed
  try {
    const result = require('child_process').execSync(`${CADDY_BIN} version`, { encoding: 'utf8', stdio: 'pipe' });
    logger.info(`Caddy found: ${result.trim()} (path: ${CADDY_BIN})`);
    proxyEnabled = true;
  } catch {
    logger.warn('Caddy not found in PATH. Install Caddy for reverse proxy support.');
    logger.warn('  Windows: choco install caddy  or  scoop install caddy');
    logger.warn('  Linux:   sudo apt install caddy  or  brew install caddy');
    logger.warn('Running in direct-access mode (no reverse proxy).');
    proxyEnabled = false;
    return false;
  }

  // Ensure data directory exists
  fs.mkdirSync(CADDY_DATA_DIR, { recursive: true });

  // Load existing active deployments into the routing table
  await rebuildRoutingTable();

  // Generate initial Caddyfile
  await generateCaddyfile();

  // Start Caddy
  return startCaddy();
}

/**
 * Rebuild the in-memory routing table from active deployments.
 */
async function rebuildRoutingTable() {
  routingTable.clear();

  const activeDeployments = await Deployment.find({ status: 'active' })
    .populate('assignedNode', 'nodeId name')
    .lean();

  for (const dep of activeDeployments) {
    const node = dep.assignedNode;
    if (!node) continue;

    const port = dep.containerInfo?.exposedPort || 0;
    if (!port) continue;

    routingTable.set(dep.domain, {
      deploymentId: dep.deploymentId,
      siteId: dep.siteId,
      domain: dep.domain,
      nodeId: node.nodeId,
      nodeName: node.name,
      port,
      version: dep.version,
    });
  }

  logger.info(`Loaded ${routingTable.size} active routes into proxy table`);
}

/**
 * Register a deployed site with the reverse proxy.
 * Called when a deployment succeeds.
 */
async function registerSite(deploymentOrOptions) {
  // Support both: registerSite(deploymentId) and registerSite({ siteId, domain, nodeId, nodeName, port, ... })
  if (typeof deploymentOrOptions === 'string') {
    // Legacy: called with deploymentId — look up via Website.activeNode
    const deployment = await Deployment.findOne({ deploymentId: deploymentOrOptions })
      .lean();
    if (!deployment || deployment.status !== 'active') return false;

    // Look up website to get the active node (may have changed after failover)
    const website = await Website.findOne({ siteId: deployment.siteId })
      .populate('activeNode', 'nodeId name tailscaleIP ipAddress')
      .lean();

    // Use activeNode if available, otherwise fall back to deployment's assignedNode
    let targetNode;
    if (website?.activeNode) {
      targetNode = website.activeNode;
    } else {
      const Node = require('../models/Node');
      targetNode = await Node.findOne({ nodeId: deployment.assignedNodeId })
        .select('nodeId name tailscaleIP ipAddress')
        .lean();
    }

    if (!targetNode) return false;

    const port = deployment.containerInfo?.exposedPort;
    if (!port) {
      logger.warn(`Cannot register site ${deployment.domain}: no exposed port`);
      return false;
    }

    // Resolve the actual address — use tunnel endpoint if available, else localhost
    const nodeAddress = await tunnelService.getNodeAddress(
      targetNode.nodeId,
      port
    );
    const targetAddress = nodeAddress || (targetNode.tailscaleIP ? `${targetNode.tailscaleIP}:${port}` : `localhost:${port}`);

    routingTable.set(deployment.domain, {
      deploymentId: deployment.deploymentId,
      siteId: deployment.siteId,
      domain: deployment.domain,
      nodeId: targetNode.nodeId,
      nodeName: targetNode.name,
      port,
      targetAddress,
      version: deployment.version,
    });

    logger.info(`Registered route: ${deployment.domain} → ${targetAddress} (node: ${targetNode.name})`);

    // Update Website with proxy info
    await Website.updateOne(
      { siteId: deployment.siteId },
      {
        $set: {
          'ports.http': port,
          'ports.https': port,
        },
      }
    );
  } else {
    // Called with direct options object (e.g., from drain/evacuation)
    const opts = deploymentOrOptions;
    if (!opts.domain || !opts.port) return false;

    const nodeAddress = opts.targetAddress || `localhost:${opts.port}`;

    routingTable.set(opts.domain, {
      deploymentId: opts.deploymentId || '',
      siteId: opts.siteId || '',
      domain: opts.domain,
      nodeId: opts.nodeId || '',
      nodeName: opts.nodeName || '',
      port: opts.port,
      targetAddress: nodeAddress,
      version: opts.version || 1,
    });

    logger.info(`Registered route: ${opts.domain} → ${nodeAddress} (node: ${opts.nodeName})`);

    if (opts.siteId) {
      await Website.updateOne(
        { siteId: opts.siteId },
        {
          $set: {
            'ports.http': opts.port,
            'ports.https': opts.port,
          },
        }
      );
    }
  }

  // Regenerate Caddyfile and reload
  await generateCaddyfile();
  await reloadCaddy();

  return true;
}

/**
 * Unregister a site from the reverse proxy.
 * Called when a site is removed or deployment fails.
 */
async function unregisterSite(domain) {
  if (!domain) return false;

  const removed = routingTable.delete(domain);
  if (removed) {
    logger.info(`Unregistered route: ${domain}`);
    await generateCaddyfile();
    await reloadCaddy();
  }
  return removed;
}

/**
 * Get the current proxy routing table.
 */
function getRoutingTable() {
  return Array.from(routingTable.values());
}

/**
 * Get a specific route by domain.
 */
function getRoute(domain) {
  return routingTable.get(domain) || null;
}

/**
 * Generate the Caddyfile from the current routing table.
 * The Caddyfile tells Caddy how to route traffic for each domain.
 */
async function generateCaddyfile() {
  if (!proxyEnabled) return false;

  const entries = Array.from(routingTable.values());

  // Also load VPS fallback sites (activeNode = null, status = active)
  const fallbackSites = await Website.find({
    status: 'active',
    activeNode: null,
  }).lean();

  let caddyfile = `# Distributed Hosting Platform — Auto-generated Caddyfile
# Last updated: ${new Date().toISOString()}
# Managed sites: ${entries.length}${fallbackSites.length > 0 ? `, fallback: ${fallbackSites.length}` : ''}

{
    admin off
    persist_config off
    data_dir ${CADDY_DATA_DIR.replace(/\\/g, '/')}
}

# Health/metrics endpoint
:2015 {
    bind 127.0.0.1
    header Content-Type "application/json"
    respond "{\\"status\\":\\"ok\\",\\"message\\":\\"Caddy reverse proxy is running\\",\\"sites\\":${entries.length}}"
}

`;

  // Add active site routes
  for (const entry of entries) {
    const target = entry.targetAddress || `localhost:${entry.port}`;
    const siteId = entry.siteId || 'unknown';
    const nodeName = entry.nodeName || 'unknown';
    const isPublicDomain = entry.domain !== 'localhost' &&
                           !entry.domain.endsWith('.localhost') &&
                           !entry.domain.endsWith('.local') &&
                           !entry.domain.endsWith('.test');

    // For each site, create appropriate blocks:
    // 1. Public domain with auto-TLS (for production)
    // 2. Local alias for testing

    if (isPublicDomain) {
      // Production block: HTTPS with auto TLS, HTTP→HTTPS redirect
      caddyfile += `# Site: ${entry.domain} (v${entry.version}) — deployed on ${nodeName}
${entry.domain} {
    # Auto TLS via Let's Encrypt
    
    # Route to node container${entry.targetAddress ? '\n    # Tunnel: ' + entry.targetAddress : ''}
    reverse_proxy ${target} {
        header_up X-Forwarded-Host ${entry.domain}
        header_up X-Node-Name ${nodeName}
        header_up X-Site-ID ${siteId}
        header_up X-Real-IP {remote_host}
    }
    
    # Security headers
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
    
    # Compression
    encode gzip zstd
    
    # Logs
    log {
        output file ${CADDY_DATA_DIR.replace(/\\/g, '/')}/logs/${entry.domain}.log
    }
}

# HTTP→HTTPS redirect
http://${entry.domain} {
    redir https://{host.port}{uri} permanent
}

`;
    } else {
      // Local/development block
      caddyfile += `# Site: ${entry.domain} (v${entry.version}) — deployed on ${nodeName}
${entry.domain} {
    reverse_proxy ${target} {
        header_up X-Forwarded-Host ${entry.domain}
        header_up X-Node-Name ${nodeName}
        header_up X-Site-ID ${siteId}
    }
    
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    
    log {
        output file ${CADDY_DATA_DIR.replace(/\\/g, '/')}/logs/${entry.domain}.log
    }
}

# Local alias — access via http://{siteId}.localhost
${siteId}.localhost {
    reverse_proxy ${target}
}

`;
    }
  }

  // Add VPS fallback routes for sites with no active node
  const fallbackPath = `${CADDY_DATA_DIR.replace(/\\/g, '/')}/fallback.html`;
  for (const site of fallbackSites) {
    const isPublicDomain = site.domain !== 'localhost' &&
                           !site.domain.endsWith('.localhost') &&
                           !site.domain.endsWith('.local') &&
                           !site.domain.endsWith('.test');

    if (isPublicDomain) {
      caddyfile += `# VPS Fallback: ${site.domain} — all nodes offline
${site.domain} {
    # Serve fallback page from VPS
    root * ${fallbackPath}
    file_server
    
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
    
    log {
        output file ${CADDY_DATA_DIR.replace(/\\/g, '/')}/logs/${site.domain}-fallback.log
    }
}

http://${site.domain} {
    redir https://{host.port}{uri} permanent
}

`;
    } else {
      caddyfile += `# VPS Fallback: ${site.domain}
${site.domain} {
    root * ${fallbackPath}
    file_server
}

`;
    }
  }

  fs.writeFileSync(CADDYFILE_PATH, caddyfile, 'utf8');
  logger.info(`Generated Caddyfile with ${entries.length} site(s): ${CADDYFILE_PATH}`);

  // Also write a hosts-style reference file for the user
  writeHostsReference(entries);

  return true;
}

/**
 * Write a reference file showing how to access sites locally.
 */
function writeHostsReference(entries) {
  const refPath = path.join(__dirname, '..', 'PROXY_ROUTES.txt');
  let content = `=== Distributed Hosting — Proxy Routes ===
Generated: ${new Date().toISOString()}

`;

  for (const entry of entries) {
    content += `  ${entry.domain.padEnd(30)} → http://localhost:${entry.port}
  ${(entry.siteId + '.localhost').padEnd(30)} → http://localhost:${entry.port}  (local alias)
  Node: ${entry.nodeName} (${entry.nodeId})
  
`;
  }

  content += `\nTo use domain names locally, add to C:\\Windows\\System32\\drivers\\etc\\hosts:\n`;
  for (const entry of entries) {
    content += `  127.0.0.1  ${entry.domain}\n`;
  }

  fs.writeFileSync(refPath, content, 'utf8');
}

// ─── Caddy Process Management ──────────────────────────────────────────

/**
 * Start the Caddy process.
 */
async function startCaddy() {
  if (!proxyEnabled) return false;
  if (caddyProcess) {
    logger.warn('Caddy is already running');
    return true;
  }

  try {
    caddyProcess = spawn(CADDY_BIN, ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    caddyProcess.stdout.on('data', (data) => {
      logger.debug(`[Caddy] ${data.toString().trim()}`);
    });

    caddyProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Caddy logs to stderr by default
      if (msg.includes('error')) {
        logger.error(`[Caddy] ${msg}`);
      } else {
        logger.debug(`[Caddy] ${msg}`);
      }
    });

    caddyProcess.on('error', (err) => {
      logger.error(`Failed to start Caddy: ${err.message}`);
      proxyEnabled = false;
      caddyProcess = null;
    });

    caddyProcess.on('exit', (code) => {
      logger.warn(`Caddy process exited with code ${code}`);
      caddyProcess = null;
    });

    // Wait a moment to verify it started
    await new Promise((resolve) => setTimeout(resolve, 1500));

    logger.info('Caddy reverse proxy started successfully');
    logger.info(`  Config: ${CADDYFILE_PATH}`);
    logger.info(`  Data:   ${CADDY_DATA_DIR}`);

    return true;
  } catch (error) {
    logger.error(`Failed to start Caddy: ${error.message}`);
    proxyEnabled = false;
    return false;
  }
}

/**
 * Reload Caddy configuration gracefully.
 */
let lastCaddyError = null;

function getLastCaddyError() {
  return lastCaddyError;
}

async function reloadCaddy() {
  if (!proxyEnabled || !caddyProcess) return false;

  try {
    const { execSync } = require('child_process');
    execSync(`${CADDY_BIN} reload --config "${CADDYFILE_PATH}"`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    lastCaddyError = null;
    logger.info(`Caddy configuration reloaded successfully (${CADDY_BIN})`);
    return true;
  } catch (error) {
    lastCaddyError = error.message;
    logger.warn(`Caddy reload error: ${error.message}`);

    // Emit proxy:update via app io if available
    try {
      // We can't access io directly here, but the event will be emitted
      // by the route handlers that call reloadCaddy
    } catch (emitErr) {
      // silent
    }

    // Try to create alert for Caddy reload failure
    try {
      const Alert = require('../models/Alert');
      const { v4: uuidv4 } = require('uuid');
      const alert = await Alert.create({
        alertId: `alert_${uuidv4().split('-')[0]}`,
        type: 'caddy_reload_failed',
        severity: 'critical',
        message: `Caddy reload failed: ${error.message}`,
        nodeId: '',
        nodeName: 'VPS',
        metadata: { error: error.message, caddyPath: CADDY_BIN },
      });
    } catch (alertErr) {
      logger.warn(`Could not create Caddy alert: ${alertErr.message}`);
    }

    return false;
  }
}

/**
 * Stop the Caddy process gracefully.
 */
async function stopCaddy() {
  if (!caddyProcess) return;

  return new Promise((resolve) => {
    caddyProcess.on('exit', () => {
      caddyProcess = null;
      proxyEnabled = false;
      resolve();
    });
    caddyProcess.kill('SIGTERM');

    // Force kill after 5 seconds
    setTimeout(() => {
      if (caddyProcess) {
        caddyProcess.kill('SIGKILL');
        caddyProcess = null;
        proxyEnabled = false;
      }
      resolve();
    }, 5000);
  });
}

/**
 * Get the status of the proxy.
 */
function getProxyStatus() {
  return {
    enabled: proxyEnabled,
    running: caddyProcess !== null,
    routes: routingTable.size,
    caddyfile: CADDYFILE_PATH,
    caddyPath: CADDY_BIN,
    lastError: lastCaddyError,
    routingTable: Array.from(routingTable.values()),
  };
}

module.exports = {
  initProxy,
  registerSite,
  unregisterSite,
  getRoutingTable,
  getRoute,
  generateCaddyfile,
  startCaddy,
  stopCaddy,
  reloadCaddy,
  getProxyStatus,
  getLastCaddyError,
  rebuildRoutingTable,
};
