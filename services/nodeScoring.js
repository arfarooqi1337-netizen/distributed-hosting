/**
 * Node scoring service
 *
 * Calculates three scores for each node:
 * - traffic_score: suitability for serving website traffic (high bandwidth, low latency, stable)
 * - compute_score: suitability for background compute jobs (high CPU/RAM, idle mode)
 * - reliability_score: based on uptime, heartbeat consistency, and error rates
 *
 * Composite score = weighted average (used for node ranking/selection)
 */

const Node = require('../models/Node');
const logger = require('../config/logger');

const SCORE_WEIGHTS = {
  traffic: { bandwidth: 0.35, latency: 0.25, stability: 0.25, mode: 0.15 },
  compute: { cpu: 0.30, ram: 0.25, mode: 0.25, stability: 0.20 },
  reliability: { uptime: 0.40, heartbeatConsistency: 0.30, errorRate: 0.30 },
};

/**
 * Calculate traffic score (0-100)
 * Best for nodes with: high bandwidth, low latency, IDLE/NORMAL mode, stable connection
 */
function calculateTrafficScore(node) {
  const { metrics } = node;
  let score = 0;

  // Bandwidth contribution (higher upload = better for traffic)
  const uploadMbps = metrics.uploadBps / (1024 * 1024);
  const bandwidthScore = Math.min(100, (uploadMbps / 50) * 100);
  score += bandwidthScore * SCORE_WEIGHTS.traffic.bandwidth;

  // Latency contribution (lower = better)
  const latencyScore = Math.max(0, 100 - metrics.latencyMs * 2);
  score += latencyScore * SCORE_WEIGHTS.traffic.latency;

  // Mode contribution
  const modeScore = node.mode === 'IDLE' ? 100 : node.mode === 'NORMAL' ? 70 : 0;
  score += modeScore * SCORE_WEIGHTS.traffic.mode;

  // Stability contribution from reliability
  score += (node.reliabilityScore || 50) * SCORE_WEIGHTS.traffic.stability;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Calculate compute score (0-100)
 * Best for nodes with: high available CPU/RAM, IDLE mode, high reliability
 */
function calculateComputeScore(node) {
  const { metrics, hardware } = node;
  let score = 0;

  // Available CPU (inverse of usage = more available = better)
  const availableCpu = 100 - (metrics.cpuPercent || 0);
  const cpuScore = (availableCpu / 100) * (hardware.cpuCoresLogical || 4) * 25;
  score += Math.min(100, cpuScore) * SCORE_WEIGHTS.compute.cpu;

  // Available RAM
  const availableRam = 100 - (metrics.ramPercent || 0);
  const ramScore = availableRam;
  score += ramScore * SCORE_WEIGHTS.compute.ram;

  // Mode contribution (IDLE = best for compute)
  const modeScore = node.mode === 'IDLE' ? 100 : node.mode === 'NORMAL' ? 60 : 0;
  score += modeScore * SCORE_WEIGHTS.compute.mode;

  // Reliability
  score += (node.reliabilityScore || 50) * SCORE_WEIGHTS.compute.stability;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Calculate reliability score (0-100)
 * Based on uptime, heartbeat consistency, and error rate
 */
function calculateReliabilityScore(node) {
  const { metrics } = node;
  let score = 50; // Start at neutral

  // Uptime bonus (longer uptime = more reliable)
  const uptimeHours = (metrics.uptimeSeconds || 0) / 3600;
  score += Math.min(30, uptimeHours * 0.5);

  // Heartbeat consistency (deduct if lastHeartbeat is old)
  if (node.lastHeartbeat) {
    const minutesSinceHeartbeat = (Date.now() - node.lastHeartbeat) / 60000;
    if (minutesSinceHeartbeat > 5) score -= 10;
    if (minutesSinceHeartbeat > 15) score -= 15;
    if (minutesSinceHeartbeat > 30) score = 0;
  }

  // Packet loss penalty
  const packetLoss = metrics.packetLoss || 0;
  if (packetLoss > 5) score -= 15;
  if (packetLoss > 20) score -= 25;

  // Status bonus
  if (node.status === 'online') score += 10;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Recalculate all scores for a node
 */
async function recalculateNodeScores(node) {
  try {
    const trafficScore = calculateTrafficScore(node);
    const computeScore = calculateComputeScore(node);
    const reliabilityScore = calculateReliabilityScore(node);

    // Composite score: weighted by node type
    let compositeScore;
    switch (node.type) {
      case 'TRAFFIC_NODE':
        compositeScore = trafficScore * 0.5 + computeScore * 0.2 + reliabilityScore * 0.3;
        break;
      case 'COMPUTE_NODE':
        compositeScore = computeScore * 0.5 + trafficScore * 0.2 + reliabilityScore * 0.3;
        break;
      default:
        compositeScore = trafficScore * 0.3 + computeScore * 0.3 + reliabilityScore * 0.4;
    }

    await Node.updateOne(
      { nodeId: node.nodeId },
      {
        $set: {
          trafficScore,
          computeScore,
          reliabilityScore,
          score: Math.round(compositeScore),
        },
      }
    );

    return { trafficScore, computeScore, reliabilityScore, score: Math.round(compositeScore) };
  } catch (error) {
    logger.error(`Failed to recalculate scores for node ${node.nodeId}:`, error.message);
    return null;
  }
}

module.exports = {
  calculateTrafficScore,
  calculateComputeScore,
  calculateReliabilityScore,
  recalculateNodeScores,
};
