/**
 * AuditLog model
 *
 * Records all admin actions for security auditing and accountability.
 * Every PATCH/POST/DELETE on admin routes should create an audit log entry.
 *
 * Fields:
 * - action: What was done (e.g., "node_type_changed", "command_dispatched")
 * - adminEmail: Who did it
 * - targetType: What type of resource was affected (node, website, job, etc.)
 * - targetId: The ID of the affected resource
 * - details: JSON blob with before/after state or relevant metadata
 * - ipAddress: The IP address of the admin who performed the action
 */

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    adminEmail: {
      type: String,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: ['node', 'website', 'job', 'alert', 'admin', 'system'],
      default: 'system',
    },
    targetId: {
      type: String,
      default: '',
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ adminEmail: 1, createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
