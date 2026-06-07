/**
 * Node model
 *
 * Represents a Windows machine (friend PC) in the distributed network.
 * Stores hardware specs, real-time metrics, mode, type classification, and scoring.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const nodeSchema = new mongoose.Schema(
  {
    nodeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    hostname: {
      type: String,
      default: '',
    },
    owner: {
      type: String,
      default: 'Unknown',
      trim: true,
    },
    apiKey: {
      type: String,
      required: true,
      unique: true,
    },
    // Type classification
    type: {
      type: String,
      enum: ['TRAFFIC_NODE', 'COMPUTE_NODE', 'BACKUP_NODE', 'DISABLED'],
      default: 'TRAFFIC_NODE',
    },
    // If true, type was manually set by admin and should not be auto-classified
    typeSetByAdmin: {
      type: Boolean,
      default: false,
    },
    // Operational mode
    mode: {
      type: String,
      enum: ['IDLE', 'NORMAL', 'GAMING', 'LOW_NETWORK', 'OFFLINE'],
      default: 'IDLE',
    },
    status: {
      type: String,
      enum: ['online', 'offline', 'busy'],
      default: 'offline',
    },
    // Version info
    version: {
      type: String,
      default: '1.0.0',
    },
    // Hardware info (static)
    hardware: {
      cpuCoresLogical: { type: Number, default: 0 },
      cpuCoresPhysical: { type: Number, default: 0 },
      ramTotalBytes: { type: Number, default: 0 },
      diskTotalBytes: { type: Number, default: 0 },
      os: { type: String, default: '' },
      processor: { type: String, default: '' },
    },
    // Runtime metrics (updated by heartbeat)
    metrics: {
      cpuPercent: { type: Number, default: 0 },
      ramPercent: { type: Number, default: 0 },
      gpuPercent: { type: Number, default: 0 },
      diskPercent: { type: Number, default: 0 },
      uploadBps: { type: Number, default: 0 },
      downloadBps: { type: Number, default: 0 },
      uptimeSeconds: { type: Number, default: 0 },
      latencyMs: { type: Number, default: 0 },
      packetLoss: { type: Number, default: 0 },
    },
    // Gaming detection
    activeGame: {
      type: Boolean,
      default: false,
    },
    gameProcesses: [{ type: String }],
    // Scoring
    score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    trafficScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    computeScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    reliabilityScore: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    // IP address (never logged, only stored for API communication)
    ipAddress: {
      type: String,
      default: '',
      select: false,
    },
    // Tunnel endpoint for reverse proxy traffic routing
    // e.g., "wg:10.0.0.2" for WireGuard, "ts:100.x.x.x" for Tailscale,
    // "direct:203.0.113.5" for direct connections
    tunnelEndpoint: {
      type: String,
      default: '',
    },
    tunnelType: {
      type: String,
      enum: ['', 'wireguard', 'tailscale', 'direct', 'zerotier'],
      default: '',
    },
    // Current workloads
    activeWebsites: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Website',
      },
    ],
    activeJobs: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Job',
      },
    ],
    // Timestamps
    firstSeen: {
      type: Date,
      default: Date.now,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    lastHeartbeat: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.apiKey;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Generate a unique API key for new nodes
nodeSchema.statics.generateApiKey = function () {
  return `nh_${crypto.randomBytes(24).toString('hex')}`;
};

// Index for heartbeat timeout queries
nodeSchema.index({ lastHeartbeat: 1 });
nodeSchema.index({ status: 1, type: 1 });
nodeSchema.index({ mode: 1 });

const Node = mongoose.model('Node', nodeSchema);

module.exports = Node;
