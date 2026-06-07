/**
 * Dashboard stats model
 *
 * Cached aggregated statistics for the admin dashboard,
 * updated periodically by the stats service.
 */

const mongoose = require('mongoose');

const dashboardStatsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      default: 'global',
    },
    totalNodes: { type: Number, default: 0 },
    onlineNodes: { type: Number, default: 0 },
    offlineNodes: { type: Number, default: 0 },
    gamingNodes: { type: Number, default: 0 },
    dockerReadyNodes: { type: Number, default: 0 },
    tailscaleReadyNodes: { type: Number, default: 0 },
    trafficNodes: { type: Number, default: 0 },
    computeNodes: { type: Number, default: 0 },
    backupNodes: { type: Number, default: 0 },
    disabledNodes: { type: Number, default: 0 },
    // Aggregate metrics
    avgCpuUsage: { type: Number, default: 0 },
    avgRamUsage: { type: Number, default: 0 },
    totalUploadMbps: { type: Number, default: 0 },
    totalDownloadMbps: { type: Number, default: 0 },
    totalDiskUsedGb: { type: Number, default: 0 },
    totalDiskAvailableGb: { type: Number, default: 0 },
    // Websites
    activeWebsites: { type: Number, default: 0 },
    unhealthyWebsites: { type: Number, default: 0 },
    // Deployments
    activeDeployments: { type: Number, default: 0 },
    failedDeployments: { type: Number, default: 0 },
    runningContainers: { type: Number, default: 0 },
    // Failovers
    recentFailovers: { type: Number, default: 0 },
    // Alerts
    unacknowledgedAlerts: { type: Number, default: 0 },
    // Jobs
    pendingJobs: { type: Number, default: 0 },
    runningJobs: { type: Number, default: 0 },
    // Timestamp
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
  }
);

const DashboardStats = mongoose.model('DashboardStats', dashboardStatsSchema);

module.exports = DashboardStats;
