/**
 * Deployment model
 *
 * Tracks every deployment attempt for a website.
 * Each deployment has a version, target node, source artifact,
 * build log, and status. Supports rollbacks by re-deploying
 * a previous deployment version.
 */

const mongoose = require('mongoose');

const deploymentSchema = new mongoose.Schema(
  {
    deploymentId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    siteId: {
      type: String,
      required: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
    },
    // Version number (auto-incremented per site)
    version: {
      type: Number,
      required: true,
    },
    // Type of deployment
    type: {
      type: String,
      enum: ['static', 'nodejs', 'python', 'docker', 'custom'],
      required: true,
    },
    // Source configuration
    source: {
      // 'upload' = zip file, 'git' = git repo, 'docker' = docker image
      type: { type: String, enum: ['upload', 'git', 'docker'], default: 'upload' },
      filename: { type: String, default: '' },
      filePath: { type: String, default: '' },
      repoUrl: { type: String, default: '' },
      branch: { type: String, default: 'main' },
      commitHash: { type: String, default: '' },
      dockerImage: { type: String, default: '' },
      dockerTag: { type: String, default: 'latest' },
      size: { type: Number, default: 0 },
      checksum: { type: String, default: '' },
    },
    // Build configuration
    buildConfig: {
      buildCommand: { type: String, default: '' },
      outputDir: { type: String, default: '' },
      installCommand: { type: String, default: '' },
      nodeVersion: { type: String, default: '18' },
      pythonVersion: { type: String, default: '3.11' },
    },
    // Status tracking
    status: {
      type: String,
      enum: [
        'pending',        // Awaiting processing
        'uploading',      // File being uploaded
        'processing',     // Being processed by controller
        'scheduling',     // Selecting target node
        'dispatching',    // Command sent to node
        'downloading',    // Node downloading artifact
        'building',       // Building on node
        'deploying',      // Deploying on node
        'active',         // Successfully deployed
        'failed',         // Deployment failed
        'rolled_back',    // Was rolled back
        'removed',        // Was removed
      ],
      default: 'pending',
    },
    // Target node
    assignedNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
    },
    assignedNodeId: {
      type: String,
      default: '',
    },
    // Timing
    scheduledAt: { type: Date },
    dispatchedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    // Progress (0-100)
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Logs
    buildLog: {
      type: String,
      default: '',
    },
    // Error info
    error: {
      message: { type: String, default: '' },
      code: { type: String, default: '' },
    },
    // Rollback support
    rollbackOf: {
      type: String,
      default: '',
    },
    // Who triggered it
    createdBy: {
      type: String,
      default: 'system',
    },
    // Container info (reported by node)
    containerInfo: {
      containerId: { type: String, default: '' },
      containerName: { type: String, default: '' },
      internalPort: { type: Number, default: 8080 },
      exposedPort: { type: Number, default: 0 },
      containerStatus: { type: String, default: '' },
      imageName: { type: String, default: '' },
      imageTag: { type: String, default: '' },
    },
    // Deployment artifacts reference
    artifacts: [{
      filename: String,
      filePath: String,
      size: Number,
      checksum: String,
      storageType: { type: String, enum: ['local', 's3', 'r2'], default: 'local' },
      uploadedAt: { type: Date, default: Date.now },
    }],
    // Multi-node deployment tracking
    nodeResults: [{
      nodeId: String,
      nodeName: String,
      role: { type: String, enum: ['primary', 'secondary', 'backup'], default: 'primary' },
      status: String,
      containerId: String,
      containerName: String,
      port: Number,
      startedAt: Date,
      completedAt: Date,
      error: String,
    }],
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

// Compound index for querying deployments by site
deploymentSchema.index({ siteId: 1, version: -1 });
deploymentSchema.index({ status: 1 });
deploymentSchema.index({ assignedNode: 1, status: 1 });

const Deployment = mongoose.model('Deployment', deploymentSchema);

module.exports = Deployment;
