/**
 * Website model
 *
 * Represents a hosted website/domain assigned to nodes in the network.
 * Supports static sites, reverse proxy, and high-availability with fallback nodes.
 */

const mongoose = require('mongoose');

const websiteSchema = new mongoose.Schema(
  {
    siteId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    customDomains: [{
      type: String,
      trim: true,
      lowercase: true,
    }],
    type: {
      type: String,
      enum: ['static', 'nodejs', 'python', 'php', 'custom'],
      default: 'static',
    },
    clientId: {
      type: String,
      default: '',
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'deploying', 'failed', 'removed'],
      default: 'deploying',
    },
    // Source configuration
    source: {
      repoUrl: { type: String, default: '' },
      branch: { type: String, default: 'main' },
      buildCommand: { type: String, default: '' },
      outputDir: { type: String, default: '' },
    },
    // Environment variables (key-value pairs, values encrypted at rest)
    environmentVariables: [{
      key: { type: String, required: true },
      value: { type: String, required: true },
    }],
    // Node assignments
    assignedNodes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Node',
      },
    ],
    // Primary compute node (serves traffic)
    primaryNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
    },
    // Secondary node for high availability (takes over if primary degrades)
    secondaryNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      default: null,
    },
    // Fallback node for emergency failover (last resort before VPS fallback)
    fallbackNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      default: null,
    },
    // Dedicated database VPS
    databaseVps: {
      type: String,
      default: '',
    },
    // Current active node (changes during failover)
    activeNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      default: null,
    },
    // Failover tracking
    failoverCount: { type: Number, default: 0 },
    lastFailoverAt: { type: Date },
    failoverHistory: [{
      from: { type: mongoose.Schema.Types.ObjectId, ref: 'Node' },
      to: { type: mongoose.Schema.Types.ObjectId, ref: 'Node' },
      reason: String,
      timestamp: { type: Date, default: Date.now },
    }],
    // Port configuration
    ports: {
      http: { type: Number, default: 80 },
      https: { type: Number, default: 443 },
      internal: { type: Number, default: 8080 },
    },
    // SSL/TLS
    ssl: {
      enabled: { type: Boolean, default: true },
      provider: { type: String, default: 'letsencrypt' },
      expiresAt: { type: Date },
    },
    // Resource limits
    resourceLimits: {
      cpuShares: { type: Number, default: 512 },
      memoryMb: { type: Number, default: 512 },
    },
    // Health checks
    lastHealthCheck: { type: Date },
    healthStatus: {
      type: String,
      enum: ['healthy', 'degraded', 'down', 'unknown'],
      default: 'unknown',
    },
    // Deployment metadata
    deployedAt: { type: Date },
    deployedBy: { type: String, default: '' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

websiteSchema.index({ status: 1 });
websiteSchema.index({ 'assignedNodes': 1 });

const Website = mongoose.model('Website', websiteSchema);

module.exports = Website;
