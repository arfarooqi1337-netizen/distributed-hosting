/**
 * Audit log routes
 *
 * Retrieval of admin action audit logs for security monitoring.
 * GET /api/admin/audit-logs — List audit logs with pagination and filters
 */

const express = require('express');
const router = express.Router();

const AuditLog = require('../models/AuditLog');
const { authenticateAdmin } = require('../middleware/auth');

/**
 * GET /api/admin/audit-logs
 * List audit logs with pagination and filtering
 * Auth: JWT admin
 * Query: action, adminEmail, targetType, targetId, limit, offset, startDate, endDate
 */
router.get('/', authenticateAdmin, async (req, res, next) => {
  try {
    const {
      action,
      adminEmail,
      targetType,
      targetId,
      limit = 50,
      offset = 0,
      startDate,
      endDate,
    } = req.query;

    const filter = {};

    if (action) filter.action = action;
    if (adminEmail) filter.adminEmail = { $regex: adminEmail, $options: 'i' };
    if (targetType) filter.targetType = targetType;
    if (targetId) filter.targetId = targetId;

    // Date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const parseNum = (val, def) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? def : Math.min(Math.max(n, 0), 1000);
    };

    const limitNum = parseNum(limit, 50);
    const offsetNum = parseNum(offset, 0);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(offsetNum)
        .limit(limitNum)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    // Get unique action types and admin emails for filter dropdowns
    const [actionTypes, adminEmails] = await Promise.all([
      AuditLog.distinct('action'),
      AuditLog.distinct('adminEmail'),
    ]);

    res.json({
      success: true,
      count: logs.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      logs,
      filters: {
        actionTypes,
        adminEmails,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/audit-logs/stats
 * Get audit log statistics (actions per day, top admins, etc.)
 * Auth: JWT admin
 */
router.get('/stats', authenticateAdmin, async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [actionCounts, adminCounts, totalLogs] = await Promise.all([
      // Count by action type (last 30 days)
      AuditLog.aggregate([
        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      // Count by admin (last 30 days)
      AuditLog.aggregate([
        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: '$adminEmail', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      AuditLog.countDocuments(),
    ]);

    res.json({
      success: true,
      totalLogs,
      last30Days: {
        actionCounts: actionCounts.map((a) => ({ action: a._id, count: a.count })),
        adminCounts: adminCounts.map((a) => ({ admin: a._id, count: a.count })),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
