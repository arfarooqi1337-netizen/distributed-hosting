/**
 * Scheduler service
 *
 * Selects the optimal node(s) for a deployment using explicit tiered priority:
 *
 *   Tier 1: Healthy TRAFFIC_NODE (IDLE/NORMAL, hosting capable, tunnel online)
 *   Tier 2: Healthy COMPUTE_NODE with required hosting capability
 *   Tier 3: Healthy BACKUP_NODE (online, any mode except OFFLINE)
 *   Final:  VPS fallback.html (no node found)
 *
 * Within each tier, nodes are scored by current load, reliability, and mode.
 */

const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const logger = require('../config/logger');

/**
 * Check if a node is eligible for a deployment type based on capabilities.
 */
function nodeSupportsDeployType(node, deployType) {
  if (!node || node.status !== 'online') return false;
  if (node.mode === 'OFFLINE') return false;
  if (node.type === 'DISABLED') return false;

  const caps = node.capabilities || {};
  if (deployType === 'static' && !caps.staticHostingSupported) return false;
  if (deployType === 'python' && !caps.dockerHostingSupported && !caps.pythonHostingSupported) return false;
  if (deployType === 'nodejs' && !caps.dockerHostingSupported && !caps.nodejsHostingSupported) return false;
  if (deployType === 'docker' && !caps.dockerHostingSupported) return false;

  // Tailscale required for production traffic
  if (!caps.tailscaleOnline && !node.tunnelEndpoint && deployType !== 'compute') return false;

  return true;
}

/**
 * Score a node within its tier (for sorting).
 * Higher = better fit within the same tier.
 */
function scoreNodeWithinTier(node, deployType) {
  let score = 0;

  // Reliability
  score += (node.reliabilityScore || 50) * 0.2;

  // Mode bonus
  if (node.mode === 'IDLE') score += 25;
  else if (node.mode === 'NORMAL') score += 15;
  else if (node.mode === 'GAMING') score += 3;

  // Load penalty
  const cpuLoad = node.metrics?.cpuPercent || 0;
  const ramLoad = node.metrics?.ramPercent || 0;
  if (cpuLoad > 80) score -= 20;
  else if (cpuLoad > 60) score -= 10;
  if (ramLoad > 80) score -= 20;
  else if (ramLoad > 60) score -= 10;

  // Type-specific score boost
  if (deployType === 'static' || deployType === 'nodejs' || deployType === 'custom') {
    score += (node.trafficScore || 0) * 0.3;
  } else if (deployType === 'docker') {
    score += (node.computeScore || 0) * 0.3;
  } else {
    score += (node.score || 0) * 0.3;
  }

  return Math.round(Math.max(1, Math.min(100, score)));
}

/**
 * Find the best node for a deployment using explicit tiered priority.
 *
 * Tier 1: TRAFFIC_NODE (IDLE or NORMAL mode)
 * Tier 2: COMPUTE_NODE that supports the hosting type
 * Tier 3: BACKUP_NODE (any online mode)
 *
 * Returns the node document or null if none available.
 */
async function findBestNode(deployType, excludeNodeIds = []) {
  const excludes = Array.isArray(excludeNodeIds) ? excludeNodeIds : [excludeNodeIds].filter(Boolean);
  const excludeQuery = excludes.length > 0 ? { nodeId: { $nin: excludes } } : {};

  // ─── Tier 1: Healthy TRAFFIC_NODE ─────────────────────────────────
  let candidates = await Node.find({
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL'] },
    type: 'TRAFFIC_NODE',
    ...excludeQuery,
  }).lean();

  const eligible = candidates.filter(n => nodeSupportsDeployType(n, deployType));
  if (eligible.length > 0) {
    eligible.sort((a, b) => scoreNodeWithinTier(b, deployType) - scoreNodeWithinTier(a, deployType));
    const best = eligible[0];
    logger.info(`[Tier 1] Selected TRAFFIC_NODE ${best.name} (score: ${scoreNodeWithinTier(best, deployType)})`);
    return best;
  }

  // ─── Tier 2: Healthy COMPUTE_NODE with hosting capability ─────────
  candidates = await Node.find({
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL', 'GAMING'] },
    type: 'COMPUTE_NODE',
    ...excludeQuery,
  }).lean();

  const computeEligible = candidates.filter(n => nodeSupportsDeployType(n, deployType));
  if (computeEligible.length > 0) {
    computeEligible.sort((a, b) => scoreNodeWithinTier(b, deployType) - scoreNodeWithinTier(a, deployType));
    const best = computeEligible[0];
    logger.info(`[Tier 2] Selected COMPUTE_NODE ${best.name} (score: ${scoreNodeWithinTier(best, deployType)})`);
    return best;
  }

  // ─── Tier 3: BACKUP_NODE (last resort) ────────────────────────────
  candidates = await Node.find({
    status: 'online',
    mode: { $ne: 'OFFLINE' },
    type: 'BACKUP_NODE',
    ...excludeQuery,
  }).lean();

  const backupEligible = candidates.filter(n => nodeSupportsDeployType(n, deployType));
  if (backupEligible.length > 0) {
    backupEligible.sort((a, b) => scoreNodeWithinTier(b, deployType) - scoreNodeWithinTier(a, deployType));
    const best = backupEligible[0];
    logger.info(`[Tier 3] Selected BACKUP_NODE ${best.name} (last resort)`);
    return best;
  }

  // ─── No node found ────────────────────────────────────────────────
  logger.warn(`No available nodes for ${deployType} deployment. All tiers exhausted.`);
  return null;
}

/**
 * Find multiple nodes for multi-node/failover deployments.
 * Returns up to `count` nodes using tiered priority.
 */
async function findBestNodes(deployType, count = 2) {
  const nodes = [];
  const excludeIds = [];

  for (let i = 0; i < count; i++) {
    const node = await findBestNode(deployType, excludeIds);
    if (!node) break;
    nodes.push(node);
    excludeIds.push(node.nodeId);
  }

  return nodes;
}

/**
 * Check if a node has capacity for another deployment.
 */
async function nodeHasCapacity(nodeId) {
  const activeCount = await Deployment.countDocuments({
    assignedNodeId: nodeId,
    status: { $in: ['dispatching', 'downloading', 'building', 'deploying', 'active'] },
  });
  return activeCount < 5;
}

module.exports = {
  findBestNode,
  findBestNodes,
  nodeHasCapacity,
};
