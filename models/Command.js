/**
 * Command model
 *
 * Tracks commands dispatched to nodes for execution.
 * Fields:
 * - commandId: Unique identifier for the command
 * - nodeId: Target node
 * - command: Command name (e.g. "docker_run", "docker_stop")
 * - params: Command parameters (varies by command)
 * - status: pending | dispatched | running | completed | failed
 * - result: Execution result payload
 * - dispatchedAt / completedAt: Timestamps
 */

const mongoose = require('mongoose');

const commandSchema = new mongoose.Schema(
  {
    commandId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    nodeId: {
      type: String,
      required: true,
      index: true,
    },
    command: {
      type: String,
      required: true,
    },
    params: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['pending', 'dispatched', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    dispatchedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: String,
      default: 'admin',
    },
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

commandSchema.index({ nodeId: 1, status: 1 });
commandSchema.index({ status: 1, createdAt: -1 });

const Command = mongoose.model('Command', commandSchema);

module.exports = Command;
