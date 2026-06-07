/**
 * Heartbeat service
 *
 * Processes incoming heartbeat data from nodes:
 * - Updates metrics, mode, and status
 * - Sanitizes all metric values
 * - Recalculates scores
 * - Classifies node type based on metrics
 * - Creates alerts for status changes
 * - Emits real-time updates via Socket.IO
 */

const Node = require('../models/Node');
const Alert = require('../models/Alert');
const { recalculateNodeScores } = require('./nodeScoring');
const { checkAndRecoverNode } = require('./recoveryService');
const logger = require('../config/logger');

/**
 * Sanitize a numeric value to ensure it's within valid range.
 * Returns the default value if the input is NaN, null, or out of range.
 */
function sanitizeMetric(value, defaultValue, min, max) {
  if (value === null || value === undefined || typeof value !== 'number') return defaultValue;
  if (isNaN(value) || !isFinite(value)) return defaultValue;
  return Math.max(min, Math.min(max, value));
}

/**
 * Sanitize all heartbeat metrics to prevent injection of invalid values.
 */
function sanitizeHeartbeatMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return { cpu: {}, ram: {}, disk: [], network: {}, uptime_seconds: 0, processes: [] };
  }

  return {
    cpu: {
      percent: sanitizeMetric(metrics.cpu?.percent, 0, 0, 100),
    },
    ram: {
      percent: sanitizeMetric(metrics.ram?.percent, 0, 0, 100),
    },
    disk: Array.isArray(metrics.disk) ? metrics.disk.map((d) => ({
      ...d,
      percent: sanitizeMetric(d.percent, 0, 0, 100),
      total_bytes: sanitizeMetric(d.total_bytes, 0, 0, Infinity),
      used_bytes: sanitizeMetric(d.used_bytes, 0, 0, Infinity),
    })) : [{ percent: 0 }],
    network: {
      upload_bps: sanitizeMetric(metrics.network?.upload_bps, 0, 0, 1e12),
      download_bps: sanitizeMetric(metrics.network?.download_bps, 0, 0, 1e12),
      packet_loss: sanitizeMetric(metrics.network?.packet_loss, 0, 0, 100),
    },
    uptime_seconds: sanitizeMetric(metrics.uptime_seconds, 0, 0, Infinity),
    processes: Array.isArray(metrics.processes) ? metrics.processes.slice(0, 100).map((p) => ({
      pid: sanitizeMetric(p.pid, 0, 0, 999999),
      name: typeof p.name === 'string' ? p.name.slice(0, 256).replace(/[<>"']/g, '') : 'unknown',
      cpu_percent: sanitizeMetric(p.cpu_percent, 0, 0, 100),
      memory_percent: sanitizeMetric(p.memory_percent, 0, 0, 100),
    })) : [],
  };
}

/**
 * Process a heartbeat from a node agent
 *
 * @param {Object} node - The Node document
 * @param {Object} heartbeatData - { mode, metrics, timestamp }
 * @param {Object} io - Socket.IO instance for real-time updates
 */
async function processHeartbeat(node, heartbeatData, io) {
  const { mode, timestamp, capabilities } = heartbeatData;
  const previousMode = node.mode;
  const previousStatus = node.status;

  // Sanitize all incoming metrics to prevent injection/invalid values
  const sanitizedMetrics = sanitizeHeartbeatMetrics(heartbeatData.metrics);

  // Update metrics with sanitized values
  const updateFields = {
    mode,
    status: 'online',
    'metrics.cpuPercent': sanitizedMetrics.cpu.percent,
    'metrics.ramPercent': sanitizedMetrics.ram.percent,
    'metrics.diskPercent': sanitizedMetrics.disk[0]?.percent ?? 0,
    'metrics.uploadBps': sanitizedMetrics.network.upload_bps,
    'metrics.downloadBps': sanitizedMetrics.network.download_bps,
    'metrics.uptimeSeconds': sanitizedMetrics.uptime_seconds,
    'metrics.packetLoss': sanitizedMetrics.network.packet_loss,
    lastHeartbeat: timestamp ? new Date(timestamp * 1000) : new Date(),
    lastSeen: new Date(),
  };

  // Gaming detection
  if (mode === 'GAMING') {
    updateFields.activeGame = true;
    updateFields.gameProcesses = sanitizedMetrics.processes
      .filter((p) => p.name && p.cpu_percent > 1)
      .map((p) => p.name);
  } else {
    updateFields.activeGame = false;
    // Don't clear game processes immediately; let them decay
  }

  // Process runtime capabilities (if provided)
  if (capabilities && typeof capabilities === 'object') {
    // Build a complete capabilities object from heartbeat data + merge with existing
    const newCaps = { ...(node.capabilities || {}) };
    const capMap = {
      tailscaleOnline: 'tailscaleOnline',
      tailscaleIp: 'tailscaleIp',
      dockerInstalled: 'dockerInstalled',
      dockerDaemonRunning: 'dockerDaemonRunning',
      dockerCliWorking: 'dockerCliWorking',
      dockerInfoOk: 'dockerInfoOk',
      dockerVersion: 'dockerVersion',
      dockerHostingSupported: 'dockerHostingSupported',
      wslEnabled: 'wslEnabled',
      agentServiceInstalled: 'agentServiceInstalled',
      agentServiceRunning: 'agentServiceRunning',
      autoStartEnabled: 'autoStartEnabled',
      staticHostingSupported: 'staticHostingSupported',
      pythonHostingSupported: 'pythonHostingSupported',
      nodejsHostingSupported: 'nodejsHostingSupported',
    };
    for (const [key, field] of Object.entries(capMap)) {
      if (capabilities[key] !== undefined) {
        newCaps[field] = capabilities[key];
      }
    }
    newCaps.lastRuntimeCheck = new Date();
    updateFields.capabilities = newCaps;

    // Also update tunnel type/endpoint from Tailscale info
    if (capabilities.tailscaleIp) {
      updateFields.tunnelEndpoint = `ts:${capabilities.tailscaleIp}`;
      updateFields.tunnelType = 'tailscale';
    }
  }

  // Update node in database
  await Node.updateOne({ nodeId: node.nodeId }, { $set: updateFields });

  // Check if node just came back online — trigger workload recovery
  if (previousStatus === 'offline' && updateFields.status === 'online') {
    const recoveredNode = await Node.findOne({ nodeId: node.nodeId });
    if (recoveredNode) {
      // Fire and forget — recovery runs asynchronously
      checkAndRecoverNode(recoveredNode, io).catch(err => {
        logger.error(`Recovery error for ${node.nodeId}: ${err.message}`);
      });
    }
  }

  // Re-fetch updated node for scoring
  const updatedNode = await Node.findOne({ nodeId: node.nodeId });
  if (!updatedNode) return;

  // Recalculate scores
  const scores = await recalculateNodeScores(updatedNode);

  // Classify node type based on metrics
  await classifyNodeType(updatedNode);

  // Check for mode change alerts
  if (previousMode !== mode) {
    await handleModeChangeAlert(updatedNode, previousMode, mode, io);
  }

  // Check for weak internet alert
  const uploadMbps = sanitizedMetrics.network.upload_bps / (1024 * 1024);
  if (uploadMbps < 1 && uploadMbps > 0 && mode !== 'GAMING' && mode !== 'OFFLINE') {
    await createAlert({
      type: 'weak_internet',
      severity: 'warning',
      message: `Node ${updatedNode.name} has weak internet (${uploadMbps.toFixed(2)} Mbps upload)`,
      nodeId: updatedNode.nodeId,
      nodeName: updatedNode.name,
      metadata: { uploadMbps },
    }, io);
  }

  // Check for high resource usage
  const cpuPercent = sanitizedMetrics.cpu.percent || 0;
  const ramPercent = sanitizedMetrics.ram.percent || 0;
  if (cpuPercent > 90) {
    await createAlert({
      type: 'high_cpu',
      severity: 'warning',
      message: `Node ${updatedNode.name} CPU at ${cpuPercent.toFixed(1)}%`,
      nodeId: updatedNode.nodeId,
      nodeName: updatedNode.name,
      metadata: { cpuPercent },
    }, io);
  }
  if (ramPercent > 90) {
    await createAlert({
      type: 'high_ram',
      severity: 'warning',
      message: `Node ${updatedNode.name} RAM at ${ramPercent.toFixed(1)}%`,
      nodeId: updatedNode.nodeId,
      nodeName: updatedNode.name,
      metadata: { ramPercent },
    }, io);
  }

  // Check for Docker/Tailscale status changes
  if (capabilities) {
    if (capabilities.dockerDaemonRunning === false && node.capabilities?.dockerDaemonRunning === true) {
      await createAlert({
        type: 'docker_offline',
        severity: 'warning',
        message: `Docker daemon stopped on node ${updatedNode.name}`,
        nodeId: updatedNode.nodeId,
        nodeName: updatedNode.name,
      }, io);
    }
    if (capabilities.tailscaleOnline === false && node.capabilities?.tailscaleOnline === true) {
      await createAlert({
        type: 'tailscale_offline',
        severity: 'warning',
        message: `Tailscale disconnected on node ${updatedNode.name}`,
        nodeId: updatedNode.nodeId,
        nodeName: updatedNode.name,
      }, io);
    }
  }

  // Emit real-time update
  if (io) {
    io.to('admin').emit('node:update', {
      nodeId: updatedNode.nodeId,
      name: updatedNode.name,
      mode: updatedNode.mode,
      status: updatedNode.status,
      type: updatedNode.type,
      metrics: updatedNode.metrics,
      score: updatedNode.score,
      scores,
      activeGame: updatedNode.activeGame,
      lastSeen: updatedNode.lastSeen,
    });
  }
}

/**
 * Classify a node's type based on its current metrics and hardware
 *
 * Only runs if the type was NOT manually set by an admin.
 * Skips classification during gaming mode and for DISABLED/BACKUP_NODE types.
 */
async function classifyNodeType(node) {
  // Skip if admin explicitly set this node's type
  if (node.typeSetByAdmin) return;

  // Skip non-auto types
  if (node.type === 'DISABLED' || node.type === 'BACKUP_NODE') return;

  // Don't reclassify during gaming
  if (node.mode === 'GAMING') return;

  const { metrics, hardware } = node;
  const uploadMbps = (metrics.uploadBps || 0) / (1024 * 1024);
  const cpuCores = hardware.cpuCoresLogical || 4;

  let newType = node.type;

  // Strong internet + good resources = TRAFFIC_NODE
  if (uploadMbps > 20 && cpuCores >= 2) {
    newType = 'TRAFFIC_NODE';
  }

  // Weak internet = COMPUTE_NODE (can't serve web traffic reliably)
  if (uploadMbps < 5) {
    newType = 'COMPUTE_NODE';
  }

  // High available CPU/RAM with good hardware = COMPUTE_NODE
  if ((metrics.cpuPercent || 0) < 30 && (metrics.ramPercent || 0) < 50 && cpuCores >= 4 && uploadMbps < 20) {
    newType = 'COMPUTE_NODE';
  }

  // High traffic capacity (high bandwidth, stable) = TRAFFIC_NODE
  if (uploadMbps > 50 && (metrics.packetLoss || 0) < 2 && cpuCores >= 2) {
    newType = 'TRAFFIC_NODE';
  }

  if (newType !== node.type) {
    await Node.updateOne({ nodeId: node.nodeId }, { $set: { type: newType } });
    logger.info(`Node ${node.name} auto-classified as ${newType}`);
  }
}

/**
 * Create an alert and emit it
 */
async function createAlert(alertData, io) {
  const { v4: uuidv4 } = require('uuid');
  try {
    const alert = await Alert.create({
      alertId: `alert_${uuidv4().split('-')[0]}`,
      ...alertData,
    });

    if (io) {
      io.to('admin').emit('alert:new', alert.toJSON());
    }

    return alert;
  } catch (error) {
    logger.error('Failed to create alert:', error.message);
  }
}

/**
 * Handle mode change events and create appropriate alerts
 */
async function handleModeChangeAlert(node, previousMode, newMode, io) {
  if (newMode === 'GAMING') {
    await createAlert({
      type: 'gaming_mode',
      severity: 'info',
      message: `Node ${node.name} entered GAMING mode`,
      nodeId: node.nodeId,
      nodeName: node.name,
      metadata: { previousMode, gameProcesses: node.gameProcesses },
    }, io);
  }

  if (previousMode === 'OFFLINE' && newMode !== 'OFFLINE') {
    await createAlert({
      type: 'node_online',
      severity: 'info',
      message: `Node ${node.name} is back online`,
      nodeId: node.nodeId,
      nodeName: node.name,
    }, io);
  }
}

module.exports = {
  processHeartbeat,
  classifyNodeType,
  createAlert,
};
