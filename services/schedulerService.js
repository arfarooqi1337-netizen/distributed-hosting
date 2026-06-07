/**
 * Scheduler service
 *
 * Selects the optimal node(s) for a deployment based on:
 * - Node type (TRAFFIC_NODE for websites, COMPUTE_NODE for jobs)
 * - Current scores (trafficScore, computeScore, reliabilityScore)
 * - Current load (CPU, RAM, active deployments)
 * - Mode (IDLE > NORMAL > GAMING/OFFLINE)
 * - Deployment type requirements
 *
 * Supports multi-node deployments for high availability.
 */

const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const logger = require('../config/logger');

/**
 * Score a node's suitability for a specific deployment type.
 * Returns a number 0-100 where higher = better fit.
 */
function scoreNodeForDeployment(node, deployType) {
  if (!node || node.status !== 'online') return 0;
  if (node.mode === 'OFFLINE') return 0;
  if (node.type === 'DISABLED') return 0;

  // Check runtime capabilities for deployment type
  const caps = node.capabilities || {};
  if (deployType === 'static' && !caps.staticHostingSupported) return 0;
  if (deployType === 'python' && !caps.dockerHostingSupported && !caps.pythonHostingSupported) return 0;
  if (deployType === 'nodejs' && !caps.dockerHostingSupported && !caps.nodejsHostingSupported) return 0;
  if (deployType === 'docker' && !caps.dockerHostingSupported) return 0;

  // Nodes without Tailscale endpoint should not receive production traffic
  if (!caps.tailscaleOnline && !node.tunnelEndpoint && deployType !== 'compute') return 0;

  let score = 0;

  // Base score from reliability
  score += (node.reliabilityScore || 50) * 0.2;

  // Mode bonus — GAMING gets a heavy penalty but is still usable
  if (node.mode === 'IDLE') score += 25;
  else if (node.mode === 'NORMAL') score += 15;
  else if (node.mode === 'GAMING') score += 5;  // Low score but still selectable

  // Check if node has capacity
  const cpuLoad = node.metrics?.cpuPercent || 0;
  const ramLoad = node.metrics?.ramPercent || 0;

  // Penalize high load
  if (cpuLoad > 80) score -= 20;
  else if (cpuLoad > 60) score -= 10;
  if (ramLoad > 80) score -= 20;
  else if (ramLoad > 60) score -= 10;

  // Type-specific scoring
  if (deployType === 'static' || deployType === 'nodejs' || deployType === 'custom') {
    // Website hosting — needs good bandwidth, low latency
    if (node.type === 'TRAFFIC_NODE') score += 30;
    score += (node.trafficScore || 0) * 0.3;
  } else if (deployType === 'docker') {
    // Docker — needs Docker enabled (future check)
    if (node.type === 'TRAFFIC_NODE' || node.type === 'COMPUTE_NODE') score += 20;
    score += (node.computeScore || 0) * 0.3;
  } else {
    // Default
    score += (node.score || 0) * 0.3;
  }

  // Avoid nodes with too many active deployments
  // (We check activeDeployments count - this is handled below)

  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Find the best node for a deployment.
 * Returns the node document or null if none available.
 *
 * @param {string} deployType - Type of deployment
 * @param {string|string[]} excludeNodeIds - NodeId or array of nodeIds to exclude
 */
async function findBestNode(deployType, excludeNodeIds = []) {
  const excludes = Array.isArray(excludeNodeIds) ? excludeNodeIds : [excludeNodeIds].filter(Boolean);

  let query = {
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL', 'GAMING'] },
    type: { $ne: 'DISABLED' },
  };

  if (excludes.length > 0) {
    query.nodeId = { $nin: excludes };
  }

  let candidates = await Node.find(query).lean();

  if (candidates.length === 0) {
    // Fallback: try anything online that isn't disabled
    query = { status: 'online', mode: { $ne: 'OFFLINE' }, type: { $ne: 'DISABLED' } };
    if (excludes.length > 0) query.nodeId = { $nin: excludes };
    candidates = await Node.find(query).lean();
    if (candidates.length > 0) {
      logger.warn('No IDLE/NORMAL/GAMING nodes found, using any online node as fallback');
    }
  }

  if (candidates.length === 0) {
    logger.warn(`No available nodes for deployment. Query: ${JSON.stringify(query)}`);
    const allNodes = await Node.find({}).select('nodeId name status mode type').lean();
    logger.warn(`All nodes in DB: ${JSON.stringify(allNodes.map(n => ({id: n.nodeId, name: n.name, status: n.status, mode: n.mode, type: n.type})))}`);
    return null;
  }

  // Score each candidate
  const scored = candidates.map((node) => ({
    node,
    score: scoreNodeForDeployment(node, deployType),
  }));

  // Sort by score descending, take the best
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score <= 0) {
    logger.warn(`Best available node scored 0 — no suitable node found. Candidates: ${JSON.stringify(candidates.map(n => ({name: n.name, status: n.status, mode: n.mode, type: n.type, cpu: n.metrics?.cpuPercent, ram: n.metrics?.ramPercent})))}`);
    return null;
  }

  logger.info(`Selected node ${best.node.name} (${best.node.nodeId}) with score ${best.score} for ${deployType} deployment`);
  return best.node;
}

/**
 * Find multiple nodes for multi-node/failover deployments.
 * Returns up to `count` nodes sorted by suitability.
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
  // Count active deployments on this node
  const activeCount = await Deployment.countDocuments({
    assignedNodeId: nodeId,
    status: { $in: ['dispatching', 'downloading', 'building', 'deploying', 'active'] },
  });

  // Allow max 5 concurrent deployments per node
  return activeCount < 5;
}

module.exports = {
  findBestNode,
  findBestNodes,
  scoreNodeForDeployment,
  nodeHasCapacity,
};
