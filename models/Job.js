/**
 * Job model
 *
 * Background compute jobs that can be assigned to COMPUTE_NODE type nodes.
 * Examples: image compression, video transcoding, data processing, ML inference.
 */

const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        'image_compression',
        'video_transcoding',
        'data_processing',
        'code_build',
        'ml_inference',
        'backup',
        'screenshot',
        'custom',
      ],
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'running', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'low',
    },
    // Assignment
    assignedNode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
    },
    assignedAt: { type: Date },
    // Input/output
    input: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    output: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Progress tracking
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    // Error handling
    error: {
      message: { type: String, default: '' },
      stack: { type: String, default: '' },
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    maxRetries: {
      type: Number,
      default: 3,
    },
    // Resource requirements
    estimatedCpu: { type: Number, default: 10 },
    estimatedRamMb: { type: Number, default: 128 },
    estimatedDurationSec: { type: Number, default: 60 },
    // Metadata
    createdBy: { type: String, default: 'system' },
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

jobSchema.index({ status: 1, priority: -1 });
jobSchema.index({ assignedNode: 1 });
jobSchema.index({ type: 1 });

const Job = mongoose.model('Job', jobSchema);

module.exports = Job;
