/**
 * Heartbeat timeout checker
 *
 * Periodically checks for nodes that haven't sent a heartbeat and
 * marks them as offline with an alert.
 */

const Node = require('../models/Node');
const Alert = require('../models/Alert');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Check for nodes that have timed out (no heartbeat within threshold)
 * and mark them as OFFLINE
 */
async function checkHeartbeatTimeouts(io) {
  try {
    const timeoutThreshold = new Date(
      Date.now() - config.heartbeat.timeoutSeconds * 1000
    );

    const timedOutNodes = await Node.find({
      status: { $ne: 'offline' },
      lastHeartbeat: { $lt: timeoutThreshold },
    });

    for (const node of timedOutNodes) {
      logger.warn(`Node ${node.name} (${node.nodeId}) heartbeat timed out. Marking offline.`);

      const previousMode = node.mode;

      await Node.updateOne(
        { nodeId: node.nodeId },
        {
          $set: {
            status: 'offline',
            mode: 'OFFLINE',
            activeGame: false,
            'metrics.cpuPercent': 0,
            'metrics.ramPercent': 0,
          },
        }
      );

      // Create offline alert
      const { v4: uuidv4 } = require('uuid');
      await Alert.create({
        alertId: `alert_${uuidv4().split('-')[0]}`,
        type: 'node_offline',
        severity: 'critical',
        message: `Node ${node.name} went offline (heartbeat timeout)`,
        nodeId: node.nodeId,
        nodeName: node.name,
        metadata: {
          previousMode,
          lastSeen: node.lastSeen,
          timeoutSeconds: config.heartbeat.timeoutSeconds,
        },
      });

      // Emit real-time update
      if (io) {
        io.to('admin').emit('node:offline', {
          nodeId: node.nodeId,
          name: node.name,
          status: 'offline',
          mode: 'OFFLINE',
          lastSeen: node.lastSeen,
        });

        io.to('admin').emit('alert:new', {
          type: 'node_offline',
          severity: 'critical',
          message: `Node ${node.name} went offline`,
          nodeId: node.nodeId,
          nodeName: node.name,
        });
      }
    }

    if (timedOutNodes.length > 0) {
      logger.info(`Marked ${timedOutNodes.length} node(s) as offline due to heartbeat timeout`);
    }
  } catch (error) {
    logger.error('Heartbeat timeout check failed:', error.message);
  }
}

/**
 * Start the periodic timeout checker
 */
function startTimeoutChecker(io) {
  const intervalMs = config.heartbeat.checkIntervalMs || 10000;

  // Run immediately
  checkHeartbeatTimeouts(io);

  // Then every interval
  return setInterval(() => checkHeartbeatTimeouts(io), intervalMs);
}

module.exports = {
  checkHeartbeatTimeouts,
  startTimeoutChecker,
};
