/**
 * Dashboard stats service
 *
 * Periodically aggregates node data into cached statistics
 * for the admin dashboard.
 */

const Node = require('../models/Node');
const Website = require('../models/Website');
const Job = require('../models/Job');
const Alert = require('../models/Alert');
const Deployment = require('../models/Deployment');
const DashboardStats = require('../models/DashboardStats');
const logger = require('../config/logger');

/**
 * Recalculate and cache all dashboard statistics
 */
async function refreshDashboardStats() {
  try {
    const nodes = await Node.find({});
    const totalNodes = nodes.length;

    const onlineNodes = nodes.filter((n) => n.status === 'online').length;
    const offlineNodes = nodes.filter((n) => n.status === 'offline').length;
    const gamingNodes = nodes.filter((n) => n.mode === 'GAMING').length;
    const dockerReadyNodes = nodes.filter((n) => n.capabilities?.dockerDaemonRunning).length;
    const tailscaleReadyNodes = nodes.filter((n) => n.capabilities?.tailscaleOnline).length;
    const trafficNodes = nodes.filter((n) => n.type === 'TRAFFIC_NODE').length;
    const computeNodes = nodes.filter((n) => n.type === 'COMPUTE_NODE').length;
    const backupNodes = nodes.filter((n) => n.type === 'BACKUP_NODE').length;
    const disabledNodes = nodes.filter((n) => n.type === 'DISABLED').length;

    // Aggregate metrics (only online nodes)
    const online = nodes.filter((n) => n.status === 'online');
    const avgCpuUsage = online.length
      ? online.reduce((sum, n) => sum + (n.metrics.cpuPercent || 0), 0) / online.length
      : 0;
    const avgRamUsage = online.length
      ? online.reduce((sum, n) => sum + (n.metrics.ramPercent || 0), 0) / online.length
      : 0;
    const totalUploadMbps = nodes.reduce(
      (sum, n) => sum + (n.metrics.uploadBps || 0) / (1024 * 1024),
      0
    );
    const totalDownloadMbps = nodes.reduce(
      (sum, n) => sum + (n.metrics.downloadBps || 0) / (1024 * 1024),
      0
    );

    // Disk totals
    let totalDiskUsed = 0;
    let totalDiskAvail = 0;
    for (const n of nodes) {
      const disk = n.metrics?.diskPercent || 0;
      const hw = n.hardware || {};
      const totalBytes = hw.diskTotalBytes || 0;
      totalDiskUsed += totalBytes * (disk / 100) || 0;
      totalDiskAvail += totalBytes * (1 - disk / 100) || 0;
    }

    // Websites
    const activeWebsites = await Website.countDocuments({ status: 'active' });
    const unhealthyWebsites = await Website.countDocuments({
      status: 'active',
      healthStatus: { $in: ['unhealthy', 'critical'] },
    });

    // Deployments
    const activeDeployments = await Deployment.countDocuments({
      status: { $in: ['active', 'dispatching', 'downloading', 'building', 'deploying'] },
    });
    const failedDeployments = await Deployment.countDocuments({ status: 'failed' });
    const runningContainers = await Deployment.countDocuments({
      status: 'active',
      'containerInfo.containerId': { $ne: '' },
    });

    // Count recent failovers (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentFailovers = await Website.countDocuments({
      'failoverHistory': { $exists: true, $ne: {} },
      'failoverHistory.0': { $exists: true },
    });

    // Jobs
    const pendingJobs = await Job.countDocuments({ status: 'pending' });
    const runningJobs = await Job.countDocuments({ status: 'running' });

    // Alerts
    const unacknowledgedAlerts = await Alert.countDocuments({ acknowledged: false });

    // Upsert stats document
    await DashboardStats.updateOne(
      { key: 'global' },
      {
        $set: {
          totalNodes,
          onlineNodes,
          offlineNodes,
          gamingNodes,
          dockerReadyNodes,
          tailscaleReadyNodes,
          trafficNodes,
          computeNodes,
          backupNodes,
          disabledNodes,
          avgCpuUsage: Math.round(avgCpuUsage * 10) / 10,
          avgRamUsage: Math.round(avgRamUsage * 10) / 10,
          totalUploadMbps: Math.round(totalUploadMbps * 100) / 100,
          totalDownloadMbps: Math.round(totalDownloadMbps * 100) / 100,
          totalDiskUsedGb: Math.round(totalDiskUsed / (1024 * 1024 * 1024) * 10) / 10,
          totalDiskAvailableGb: Math.round(totalDiskAvail / (1024 * 1024 * 1024) * 10) / 10,
          activeWebsites,
          unhealthyWebsites,
          activeDeployments,
          failedDeployments,
          runningContainers,
          recentFailovers,
          pendingJobs,
          runningJobs,
          unacknowledgedAlerts,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    logger.debug('Dashboard stats refreshed');
  } catch (error) {
    logger.error('Failed to refresh dashboard stats:', error.message);
  }
}

/**
 * Start periodic stats refresh
 */
function startStatsRefresh(intervalMs = 10000) {
  // Refresh immediately
  refreshDashboardStats();

  // Then every interval
  return setInterval(refreshDashboardStats, intervalMs);
}

module.exports = {
  refreshDashboardStats,
  startStatsRefresh,
};
