/**
 * NodeHistory model
 *
 * Time-series data for node metrics over time.
 * Used for charts, trends, and historical analysis.
 * Documents are automatically deleted after 30 days (TTL index).
 */

const mongoose = require('mongoose');

const nodeHistorySchema = new mongoose.Schema({
  nodeId: {
    type: String,
    required: true,
    index: true,
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
  },
  mode: {
    type: String,
    enum: ['IDLE', 'NORMAL', 'GAMING', 'OFFLINE'],
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'busy'],
  },
  metrics: {
    cpuPercent: { type: Number, default: 0 },
    ramPercent: { type: Number, default: 0 },
    gpuPercent: { type: Number, default: 0 },
    diskPercent: { type: Number, default: 0 },
    uploadBps: { type: Number, default: 0 },
    downloadBps: { type: Number, default: 0 },
    uptimeSeconds: { type: Number, default: 0 },
    packetLoss: { type: Number, default: 0 },
  },
  score: {
    type: Number, default: 0,
  },
});

// Compound index for efficient time-range queries per node
nodeHistorySchema.index({ nodeId: 1, timestamp: -1 });

// TTL index: auto-delete documents after 30 days
nodeHistorySchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

const NodeHistory = mongoose.model('NodeHistory', nodeHistorySchema);

module.exports = NodeHistory;
