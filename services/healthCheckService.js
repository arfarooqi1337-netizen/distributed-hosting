/**
 * Health Check service
 *
 * Periodically performs HTTP health checks on active websites
 * to verify they are reachable and responding correctly.
 * Updates website healthStatus and creates alerts on failures.
 */

const http = require('http');
const https = require('https');
const Website = require('../models/Website');
const Alert = require('../models/Alert');
const logger = require('../config/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Perform a single health check on a website.
 * Returns 'healthy', 'degraded', or 'down'.
 */
async function checkWebsiteHealth(website) {
  return new Promise((resolve) => {
    const url = `http${website.ssl?.enabled ? 's' : ''}://${website.domain}`;
    const client = website.ssl?.enabled ? https : http;

    const req = client.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const statusCode = res.statusCode || 0;
      // Consume response data to free up memory
      res.resume();

      if (statusCode >= 200 && statusCode < 400) {
        resolve('healthy');
      } else if (statusCode >= 400 && statusCode < 500) {
        // Client errors (4xx) might be the website's issue
        resolve('degraded');
      } else {
        resolve('down');
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('down');
    });

    req.on('error', () => {
      resolve('down');
    });
  });
}

/**
 * Run health checks on all active websites.
 */
async function runHealthChecks() {
  try {
    const websites = await Website.find({
      status: { $in: ['active', 'deploying'] },
      domain: { $ne: '' },
    }).lean();

    if (websites.length === 0) return;

    let checked = 0;
    let alertsCreated = 0;

    for (const website of websites) {
      try {
        const health = await checkWebsiteHealth(website);
        const previousHealth = website.healthStatus || 'unknown';

        await Website.updateOne(
          { siteId: website.siteId },
          {
            $set: {
              healthStatus: health,
              lastHealthCheck: new Date(),
            },
          }
        );

        // Create alert on status change to unhealthy
        if (previousHealth !== 'down' && health === 'down') {
          await Alert.create({
            alertId: `alert_${require('uuid').v4().split('-')[0]}`,
            type: 'website_down',
            severity: 'critical',
            message: `Website ${website.domain} is down (health check failed)`,
            nodeId: '',
            nodeName: '',
            metadata: {
              siteId: website.siteId,
              domain: website.domain,
              previousHealth,
            },
          });
          alertsCreated++;
        }

        checked++;
      } catch (err) {
        logger.error(`Health check failed for ${website.domain}:`, err.message);
      }
    }

    if (alertsCreated > 0) {
      logger.info(`Health checks: ${checked}/${websites.length} checked, ${alertsCreated} alerts`);
    }
  } catch (error) {
    logger.error('Health check cycle failed:', error.message);
  }
}

/**
 * Start the periodic health check service.
 */
function startHealthChecks() {
  logger.info('Starting website health check service (interval: 5min)');
  runHealthChecks();
  return setInterval(runHealthChecks, CHECK_INTERVAL_MS);
}

module.exports = {
  runHealthChecks,
  startHealthChecks,
};
