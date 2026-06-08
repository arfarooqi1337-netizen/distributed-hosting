/**
 * Deployment timeout service
 *
 * Periodically checks for deployments that have been stuck in
 * intermediate states (dispatching, downloading, building, deploying)
 * for too long and marks them as failed with a clear error.
 *
 * This prevents deployments from staying stuck forever.
 */

const Deployment = require('../models/Deployment');
const Alert = require('../models/Alert');
const logger = require('../config/logger');

const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds
const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max for any stage

async function checkStuckDeployments(io) {
  try {
    const stuckDeployments = await Deployment.find({
      status: { $in: ['dispatching', 'downloading', 'building', 'deploying', 'scheduling'] },
      updatedAt: { $lt: new Date(Date.now() - STUCK_TIMEOUT_MS) },
    }).lean();

    for (const dep of stuckDeployments) {
      logger.warn(`Deployment ${dep.deploymentId} stuck in '${dep.status}' for over 5 minutes — failing`);

      await Deployment.updateOne(
        { deploymentId: dep.deploymentId },
        {
          $set: {
            status: 'failed',
            progress: 0,
            error: {
              message: `Deployment timed out in '${dep.status}' state after 5 minutes`,
              code: 'DEPLOYMENT_TIMEOUT',
            },
            completedAt: new Date(),
          },
        }
      );

      // Create alert
      const { v4: uuidv4 } = require('uuid');
      try {
        const alert = await Alert.create({
          alertId: `alert_${uuidv4().split('-')[0]}`,
          type: 'deployment_failed',
          severity: 'critical',
          message: `Deployment ${dep.deploymentId} timed out for ${dep.domain || 'unknown'}`,
          nodeId: dep.assignedNodeId || '',
          metadata: { deploymentId: dep.deploymentId, siteId: dep.siteId, stuckStatus: dep.status },
        });
        if (io) io.to('admin').emit('alert:new', alert.toJSON());
      } catch (err) {
        logger.warn(`Failed to create alert for stuck deployment: ${err.message}`);
      }

      if (io) {
        io.to('admin').emit('deployment:update', {
          deploymentId: dep.deploymentId,
          status: 'failed',
          error: { message: 'Deployment timed out', code: 'DEPLOYMENT_TIMEOUT' },
        });
      }
    }
  } catch (error) {
    logger.error(`Stuck deployment check failed: ${error.message}`);
  }
}

function startDeploymentTimeoutChecker(io) {
  logger.info(`Deployment timeout checker started (${STUCK_TIMEOUT_MS / 1000}s threshold, check every ${CHECK_INTERVAL_MS / 1000}s)`);
  checkStuckDeployments(io);
  return setInterval(() => checkStuckDeployments(io), CHECK_INTERVAL_MS);
}

module.exports = { startDeploymentTimeoutChecker, checkStuckDeployments };
