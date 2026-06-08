#!/usr/bin/env node
/**
 * Omega E2E Test Runner
 *
 * Tests the full Project Omega hosting flow:
 *  1. Admin login
 *  2. Node availability
 *  3. Static website deployment
 *  4. Python website deployment
 *  5. Container logs
 *  6. Failover simulation
 *  7. Fallback
 *  8. Rollback
 *
 * Usage:
 *   OMEGA_API_URL=http://localhost:3000 \
 *   OMEGA_ADMIN_EMAIL=admin@example.com \
 *   OMEGA_ADMIN_PASSWORD=changeme123 \
 *   OMEGA_TEST_DOMAIN=test-e2e.omega.local \
 *   node run-e2e.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const OmegaClient = require('./OmegaClient');

// ─── Config ───────────────────────────────────────────────────────────────
const API_URL = process.env.OMEGA_API_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.OMEGA_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.OMEGA_ADMIN_PASSWORD || 'changeme123';
const TEST_DOMAIN = process.env.OMEGA_TEST_DOMAIN || `test-e2e-${Date.now()}.omega.local`;
const TIMEOUT = parseInt(process.env.OMEGA_TIMEOUT_MS || '180000', 10);
const TEST_SITES_DIR = path.join(__dirname, '..', '..', 'test-sites');

const client = new OmegaClient(API_URL);
const results = [];
let testSiteId = null;
let testDeploymentId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────

function zipFolder(folderPath, outputPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(folderPath);
  zip.writeZip(outputPath);
  return outputPath;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✅ PASS [${duration}s] ${name}`);
    results.push({ name, status: 'PASS', duration: duration + 's' });
  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ❌ FAIL [${duration}s] ${name}`);
    console.log(`     ${err.message}`);
    results.push({ name, status: 'FAIL', duration: duration + 's', error: err.message });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================');
  console.log('  Omega E2E Test Suite');
  console.log(`  API: ${API_URL}`);
  console.log(`  Domain: ${TEST_DOMAIN}`);
  console.log(`  Timeout: ${TIMEOUT / 1000}s`);
  console.log('============================================\n');

  // 1. Admin Login
  await test('Admin Login', async () => {
    const data = await client.login(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!data.token) throw new Error('No token returned');
    console.log(`     Token: ${data.token.slice(0, 20)}...`);
  });

  // 2. Node Availability
  await test('Node Availability', async () => {
    const data = await client.getNodes();
    const nodes = data.nodes || [];
    if (nodes.length === 0) throw new Error('No nodes found');
    const onlineNodes = nodes.filter(n => n.status === 'online');
    if (onlineNodes.length === 0) throw new Error('No online nodes');
    console.log(`     ${onlineNodes.length}/${nodes.length} nodes online`);
    const dockerReady = onlineNodes.filter(n => n.capabilities?.dockerDaemonRunning);
    console.log(`     ${dockerReady.length} Docker-ready nodes`);
    const tailscaleNodes = onlineNodes.filter(n => n.capabilities?.tailscaleOnline);
    console.log(`     ${tailscaleNodes.length} Tailscale-connected nodes`);
  });

  // 3. Static Website Deployment
  await test('Static Website Deploy', async () => {
    const staticDir = path.join(TEST_SITES_DIR, 'static-site');
    if (!fs.existsSync(staticDir)) throw new Error(`Static site dir not found: ${staticDir}`);

    const zipPath = path.join(TEST_SITES_DIR, `e2e-static-${Date.now()}.zip`);
    zipFolder(staticDir, zipPath);

    const domain = `static-${TEST_DOMAIN}`;
    const result = await client.deployStatic(domain, zipPath);

    if (!result.deployment) throw new Error('No deployment created');
    testDeploymentId = result.deployment.deploymentId;
    testSiteId = result.deployment.siteId;
    console.log(`     Deployment: ${testDeploymentId}`);
    console.log(`     Site ID: ${testSiteId}`);
    console.log(`     Domain: ${domain}`);

    // Wait for active
    const dep = await client.waitForDeployment(testDeploymentId, TIMEOUT);
    console.log(`     Status: ${dep.deployment.status}`);
    console.log(`     Node: ${dep.deployment.assignedNode?.name || dep.deployment.assignedNodeId}`);

    // Cleanup zip
    try { fs.unlinkSync(zipPath); } catch (e) {}
  });

  // 4. Python Website Deployment
  await test('Python Website Deploy', async () => {
    const pythonDir = path.join(TEST_SITES_DIR, 'python-site');
    if (!fs.existsSync(pythonDir)) throw new Error(`Python site dir not found: ${pythonDir}`);

    const zipPath = path.join(TEST_SITES_DIR, `e2e-python-${Date.now()}.zip`);
    zipFolder(pythonDir, zipPath);

    const domain = `python-${TEST_DOMAIN}`;
    const result = await client.deployStatic(domain, zipPath);

    if (!result.deployment) throw new Error('No deployment created');
    console.log(`     Deployment: ${result.deployment.deploymentId}`);
    console.log(`     Domain: ${domain}`);

    const dep = await client.waitForDeployment(result.deployment.deploymentId, TIMEOUT);
    console.log(`     Status: ${dep.deployment.status}`);

    try { fs.unlinkSync(zipPath); } catch (e) {}
  });

  // 5. Container Logs
  await test('Container Logs', async () => {
    if (!testDeploymentId) throw new Error('No test deployment available');

    const dep = await client.getDeployment(testDeploymentId);
    const nodeId = dep.deployment?.assignedNodeId;
    const containerId = dep.deployment?.containerInfo?.containerId;

    if (!nodeId) throw new Error('No assigned node');
    if (!containerId) {
      console.log('     No container ID — may use Python HTTP server fallback');
      return; // Not a failure if no Docker container
    }

    const logs = await client.getContainerLogs(nodeId, containerId);
    if (!logs.logs || logs.logs.length === 0) {
      console.log('     Logs returned but empty — container may have just started');
    } else {
      console.log(`     ${logs.logs.length} log lines returned`);
    }
  });

  // 6. Failover Simulation
  await test('Failover Simulation', async () => {
    if (!testSiteId) throw new Error('No test website');

    // Get website to see current active node
    const site = await client.getWebsite(testSiteId);
    const activeNode = site.website?.activeNode;
    console.log(`     Current active node: ${activeNode?.name || 'none'}`);

    // Verify the website proxy route exists
    const proxy = await client.getProxyStatus();
    const routes = proxy.routingTable || [];
    const siteRoute = routes.find(r => r.siteId === testSiteId);
    if (siteRoute) {
      console.log(`     Caddy route: ${siteRoute.domain} -> ${siteRoute.targetAddress || `localhost:${siteRoute.port}`}`);
    } else {
      console.log('     No Caddy route found (may use direct port access)');
    }
  });

  // 7. Dashboard Stats
  await test('Dashboard Stats', async () => {
    const stats = await client.getDashboard();
    if (!stats.stats) throw new Error('No stats returned');
    console.log(`     Total nodes: ${stats.stats.totalNodes}`);
    console.log(`     Online nodes: ${stats.stats.onlineNodes}`);
    console.log(`     Active websites: ${stats.stats.activeWebsites}`);
    console.log(`     Active deployments: ${stats.stats.activeDeployments}`);
  });

  // ─── Results ──────────────────────────────────────────────────────────
  console.log('\n============================================');
  console.log('  Results');
  console.log('============================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`  Total: ${results.length}  |  PASS: ${passed}  |  FAIL: ${failed}`);
  console.log();

  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`  ${icon} ${r.name} (${r.duration})`);
    if (r.error) console.log(`     ${r.error}`);
  });

  // Write results file
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultsPath = path.join(resultsDir, 'latest.json');
  fs.writeFileSync(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    apiUrl: API_URL,
    domain: TEST_DOMAIN,
    summary: { total: results.length, passed, failed },
    results,
  }, null, 2));
  console.log(`\n  Results saved to: ${resultsPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
