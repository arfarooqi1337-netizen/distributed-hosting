/**
 * Alert model
 *
 * System alerts triggered by node status changes, gaming mode detection,
 * weak internet, or other important events.
 */

const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema(
  {
    alertId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'node_offline',
        'node_online',
        'gaming_mode',
        'weak_internet',
        'high_latency',
        'high_cpu',
        'high_ram',
        'disk_full',
        'job_failed',
        'website_down',
        'cert_expiring',
        'info',
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'info',
    },
    message: {
      type: String,
      required: true,
    },
    nodeId: {
      type: String,
      default: null,
    },
    nodeName: {
      type: String,
      default: '',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    acknowledged: {
      type: Boolean,
      default: false,
    },
    acknowledgedBy: {
      type: String,
      default: '',
    },
    acknowledgedAt: { type: Date },
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

alertSchema.index({ type: 1, acknowledged: 1 });
alertSchema.index({ createdAt: -1 });

const Alert = mongoose.model('Alert', alertSchema);

module.exports = Alert;
