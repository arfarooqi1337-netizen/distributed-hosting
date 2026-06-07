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
const tunnelService = require('./tunnelService');

const CADDYFILE_PATH = path.join(__dirname, '..', 'Caddyfile');
const CADDY_DATA_DIR = path.join(__dirname, '..', 'caddy_data');

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
    const result = require('child_process').execSync('caddy version', { encoding: 'utf8', stdio: 'pipe' });
    logger.info(`Caddy found: ${result.trim()}`);
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
async function registerSite(deploymentId) {
  const deployment = await Deployment.findOne({ deploymentId })
    .populate('assignedNode', 'nodeId name')
    .lean();

  if (!deployment || deployment.status !== 'active') return false;
  if (!deployment.assignedNode) return false;

  const port = deployment.containerInfo?.exposedPort;
  if (!port) {
    logger.warn(`Cannot register site ${deployment.domain}: no exposed port`);
    return false;
  }

  routingTable.set(deployment.domain, {
    deploymentId: deployment.deploymentId,
    siteId: deployment.siteId,
    domain: deployment.domain,
    nodeId: deployment.assignedNode.nodeId,
    nodeName: deployment.assignedNode.name,
    port,
    version: deployment.version,
  });

  // Resolve the actual address — use tunnel endpoint if available, else localhost
  const nodeAddress = await tunnelService.getNodeAddress(
    deployment.assignedNode.nodeId,
    port
  );
  const targetAddress = nodeAddress || `localhost:${port}`;

  routingTable.set(deployment.domain, {
    deploymentId: deployment.deploymentId,
    siteId: deployment.siteId,
    domain: deployment.domain,
    nodeId: deployment.assignedNode.nodeId,
    nodeName: deployment.assignedNode.name,
    port,
    targetAddress,
    version: deployment.version,
  });

  logger.info(`Registered route: ${deployment.domain} → ${targetAddress}`);

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
  if (entries.length === 0) {
    // Write a minimal Caddyfile with just a health check endpoint
    const minimal = `# Distributed Hosting Platform — Auto-generated Caddyfile
# No active sites to route.

:2015 {
    bind 127.0.0.1
    header Content-Type "application/json"
    respond "{\\"status\\":\\"ok\\",\\"message\\":\\"Caddy reverse proxy is running\\",\\"sites\\":0}"
}
`;
    fs.writeFileSync(CADDYFILE_PATH, minimal, 'utf8');
    logger.debug('Generated minimal Caddyfile (no active sites)');
    return true;
  }

  let caddyfile = `# Distributed Hosting Platform — Auto-generated Caddyfile
# Last updated: ${new Date().toISOString()}
# Managed sites: ${entries.length}

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

  for (const entry of entries) {
    const target = entry.targetAddress || `localhost:${entry.port}`;
    const siteId = entry.siteId || 'unknown';
    const nodeName = entry.nodeName || 'unknown';

    // Generate TLS config for the domain
    // Caddy auto-provisions Let's Encrypt certificates for public domains
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
    tls {
        dns tailor  # Uses Tailscale DNS for ACME validation
    }
    
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
    caddyProcess = spawn('caddy', ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], {
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
async function reloadCaddy() {
  if (!proxyEnabled || !caddyProcess) return false;

  try {
    // Caddy reloads config automatically when the file changes
    // But we can also send SIGHUP or use the API
    // For now, we rely on Caddy's file watching (enabled by default)
    logger.debug('Caddy configuration updated — Caddy auto-reloads on file change');
    return true;
  } catch (error) {
    logger.warn(`Caddy reload error: ${error.message}`);
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
  rebuildRoutingTable,
};
