/**
 * Audit logging middleware
 *
 * Attaches an auditLog helper to the response object so routes can
 * easily record admin actions.
 *
 * Usage:
 *   router.patch('/:nodeId', authenticateAdmin, auditMiddleware, async (req, res) => {
 *     // ... do work ...
 *     await res.auditLog('node_type_changed', 'node', nodeId, { from: oldType, to: newType });
 *   });
 */

const AuditLog = require('../models/AuditLog');

async function auditMiddleware(req, res, next) {
  res.auditLog = async (action, targetType, targetId, details = {}) => {
    try {
      await AuditLog.create({
        action,
        adminEmail: req.admin?.email || 'unknown',
        targetType,
        targetId: targetId || '',
        details,
        ipAddress: req.ip || req.connection?.remoteAddress || '',
      });
    } catch (error) {
      // Audit logging should never block the main request
      console.error('Audit log error:', error.message);
    }
  };
  next();
}

module.exports = { auditMiddleware };
