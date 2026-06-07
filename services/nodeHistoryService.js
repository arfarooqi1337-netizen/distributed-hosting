/**
 * Node History service
 *
 * Periodically snapshots node metrics into the NodeHistory collection
 * for time-series analysis and charting.
 * Runs every 60 seconds and batch-inserts all nodes' current state.
 */

const Node = require('../models/Node');
const NodeHistory = require('../models/NodeHistory');
const logger = require('../config/logger');

const BATCH_INTERVAL_MS = 60000; // 1 minute

/**
 * Snapshot all online nodes' current metrics into history.
 */
async function snapshotNodeMetrics() {
  try {
    const nodes = await Node.find({ status: 'online' })
      .select('nodeId mode status metrics score')
      .lean();

    if (nodes.length === 0) return;

    const now = new Date();
    const historyDocs = nodes.map((node) => ({
      nodeId: node.nodeId,
      timestamp: now,
      mode: node.mode,
      status: node.status,
      metrics: {
        cpuPercent: node.metrics?.cpuPercent || 0,
        ramPercent: node.metrics?.ramPercent || 0,
        gpuPercent: node.metrics?.gpuPercent || 0,
        diskPercent: node.metrics?.diskPercent || 0,
        uploadBps: node.metrics?.uploadBps || 0,
        downloadBps: node.metrics?.downloadBps || 0,
        uptimeSeconds: node.metrics?.uptimeSeconds || 0,
        packetLoss: node.metrics?.packetLoss || 0,
      },
      score: node.score || 0,
    }));

    await NodeHistory.insertMany(historyDocs, { ordered: false });
    logger.debug(`Snapshotted ${historyDocs.length} node metrics to history`);
  } catch (error) {
    // Suppress duplicate key errors (race conditions are fine)
    if (error.code !== 11000) {
      logger.error('Failed to snapshot node metrics:', error.message);
    }
  }
}

/**
 * Start the periodic history snapshot service.
 */
function startNodeHistorySnapshot() {
  snapshotNodeMetrics();
  return setInterval(snapshotNodeMetrics, BATCH_INTERVAL_MS);
}

module.exports = {
  snapshotNodeMetrics,
  startNodeHistorySnapshot,
};
