/**
 * Project model
 *
 * Represents a client project/website. Links clients to their websites,
 * deployments, domains, and resources. A client can have multiple projects.
 *
 * Prepared for Phase 2 client portal integration.
 */

const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['static', 'nodejs', 'python', 'php', 'docker', 'custom'],
      default: 'static',
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'archived', 'suspended'],
      default: 'active',
    },
    // Link to website record
    siteId: {
      type: String,
      default: '',
    },
    // Source configuration
    source: {
      repoUrl: { type: String, default: '' },
      branch: { type: String, default: 'main' },
      buildCommand: { type: String, default: '' },
      outputDir: { type: String, default: '' },
      installCommand: { type: String, default: '' },
    },
    // Deployment settings
    autoDeploy: {
      type: Boolean,
      default: false,
    },
    deployBranch: {
      type: String,
      default: 'main',
    },
    // Hosting configuration
    hosting: {
      nodeRequirement: {
        type: String,
        enum: ['any', 'traffic', 'compute', 'gpu'],
        default: 'any',
      },
      minNodes: { type: Number, default: 1 },
      maxNodes: { type: Number, default: 3 },
      regions: [{ type: String }],
    },
    // Resource usage
    resourceLimits: {
      cpuShares: { type: Number, default: 512 },
      memoryMb: { type: Number, default: 512 },
      storageMb: { type: Number, default: 1024 },
      bandwidthMb: { type: Number, default: 10240 },
    },
    // Current deployment
    currentVersion: { type: Number, default: 0 },
    lastDeployedAt: { type: Date },
    lastDeployedBy: { type: String, default: '' },
    // Domains associated with this project
    domains: [{
      domain: String,
      isPrimary: { type: Boolean, default: false },
      sslEnabled: { type: Boolean, default: true },
      dnsVerified: { type: Boolean, default: false },
    }],
    // Metadata
    tags: [{ type: String }],
    notes: { type: String, default: '' },
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

projectSchema.index({ clientId: 1, status: 1 });
projectSchema.index({ siteId: 1 });

const Project = mongoose.model('Project', projectSchema);

module.exports = Project;
