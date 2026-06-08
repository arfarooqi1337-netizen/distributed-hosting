/**
 * Deployment orchestration service
 *
 * The heart of the platform — transforms uploaded websites, apps,
 * and containers into running workloads on community nodes.
 *
 * Flow:
 *   1. Receive deployment request (upload zip / git URL / docker image)
 *   2. Store artifact and verify integrity
 *   3. Select best node via scheduler
 *   4. Dispatch deploy command to node via Socket.IO
 *   5. Node downloads artifact, builds, deploys
 *   6. Node reports status back
 *   7. Update website record with live status
 *   8. Configure reverse proxy (future)
 *
 * Supports: static sites, Node.js apps, Python apps, Docker containers
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Node = require('../models/Node');
const Website = require('../models/Website');
const Deployment = require('../models/Deployment');
const Command = require('../models/Command');
const Alert = require('../models/Alert');
const { findBestNode, findBestNodes, nodeHasCapacity } = require('./schedulerService');
const storageService = require('./storageService');
const proxyService = require('./proxyService');
const logger = require('../config/logger');

/**
 * Get the next version number for a site's deployments.
 */
async function getNextVersion(siteId) {
  const lastDeploy = await Deployment.findOne({ siteId })
    .sort({ version: -1 })
    .select('version')
    .lean();
  return (lastDeploy?.version || 0) + 1;
}

/**
 * Create a new deployment record.
 */
async function createDeployment({ siteId, domain, type, source, buildConfig, createdBy }) {
  const deploymentId = `deploy_${uuidv4().split('-')[0]}`;
  const version = await getNextVersion(siteId);

  const deployment = await Deployment.create({
    deploymentId,
    siteId,
    domain,
    version,
    type: type || 'static',
    source: {
      type: source.type || 'upload',
      filename: source.filename || '',
      repoUrl: source.repoUrl || '',
      branch: source.branch || 'main',
      dockerImage: source.dockerImage || '',
      dockerTag: source.dockerTag || 'latest',
      size: source.size || 0,
      checksum: source.checksum || '',
    },
    buildConfig: {
      buildCommand: buildConfig?.buildCommand || '',
      outputDir: buildConfig?.outputDir || '',
      installCommand: buildConfig?.installCommand || '',
      nodeVersion: buildConfig?.nodeVersion || '18',
      pythonVersion: buildConfig?.pythonVersion || '3.11',
    },
    status: 'pending',
    createdBy: createdBy || 'admin',
  });

  logger.info(`Deployment created: ${deploymentId} v${version} for ${domain}`);
  return deployment;
}

/**
 * Process a deployment — the main orchestration function.
 * Called after the artifact is uploaded and ready.
 */
async function processDeployment(deploymentId, io) {
  const deployment = await Deployment.findOne({ deploymentId });
  if (!deployment) {
    logger.error(`Deployment ${deploymentId} not found`);
    return null;
  }

  try {
    // 1. Mark as processing
    await Deployment.updateOne(
      { deploymentId },
      { $set: { status: 'scheduling', scheduledAt: new Date() } }
    );

    // 2. Select nodes for multi-node deployment
    const nodes = await findBestNodes(deployment.type, 3);
    if (nodes.length === 0) {
      await failDeployment(deploymentId, 'No available nodes found', 'NO_NODE_AVAILABLE');
      return null;
    }

    const primaryNode = nodes[0];
    const secondaryNode = nodes.length > 1 ? nodes[1] : null;
    const backupNode = nodes.length > 2 ? nodes[2] : null;

    // 3. Check primary node capacity
    const hasCapacity = await nodeHasCapacity(primaryNode.nodeId);
    if (!hasCapacity) {
      logger.warn(`Primary node ${primaryNode.name} at capacity, trying fallback`);
      if (secondaryNode) {
        const temp = primaryNode;
        nodes[0] = secondaryNode;
        nodes[1] = temp;
      } else {
        await failDeployment(deploymentId, 'All nodes at capacity', 'NO_CAPACITY');
        return null;
      }
    }

    const deployNode = nodes[0];

    // 4. Update deployment with assigned node(s)
    const nodeResults = [{
      nodeId: deployNode.nodeId,
      nodeName: deployNode.name,
      role: 'primary',
      status: 'dispatching',
    }];

    if (secondaryNode) {
      nodeResults.push({
        nodeId: secondaryNode.nodeId,
        nodeName: secondaryNode.name,
        role: 'secondary',
        status: 'pending',
      });
    }
    if (backupNode) {
      nodeResults.push({
        nodeId: backupNode.nodeId,
        nodeName: backupNode.name,
        role: 'backup',
        status: 'pending',
      });
    }

    await Deployment.updateOne(
      { deploymentId },
      {
        $set: {
          status: 'dispatching',
          assignedNode: deployNode._id,
          assignedNodeId: deployNode.nodeId,
          dispatchedAt: new Date(),
          nodeResults,
        },
      }
    );

    // 5. Create the deploy command for primary node
    const commandId = uuidv4();
    const deployParams = {
      deploymentId: deployment.deploymentId,
      domain: deployment.domain,
      type: deployment.type,
      sourceType: deployment.source.type,
      role: 'primary',
      // For upload type, provide download URL
      downloadUrl: deployment.source.type === 'upload'
        ? `/api/deployments/${deployment.deploymentId}/download`
        : '',
      repoUrl: deployment.source.repoUrl,
      branch: deployment.source.branch,
      dockerImage: deployment.source.dockerImage,
      dockerTag: deployment.source.dockerTag,
      buildCommand: deployment.buildConfig.buildCommand,
      outputDir: deployment.buildConfig.outputDir,
      installCommand: deployment.buildConfig.installCommand,
      nodeVersion: deployment.buildConfig.nodeVersion,
      pythonVersion: deployment.buildConfig.pythonVersion,
      internalPort: 8080,
    };

    const cmd = await Command.create({
      commandId,
      nodeId: deployNode.nodeId,
      command: 'deploy_site',
      params: deployParams,
      status: 'pending',
      createdBy: 'deployment-service',
    });

    // 6. Notify the primary node via Socket.IO (if connected)
    if (io) {
      io.to(`node:${deployNode.nodeId}`).emit('command:new', {
        commandId: cmd.commandId,
        command: cmd.command,
        params: cmd.params,
      });

      // Also dispatch to secondary node if available
      if (secondaryNode) {
        const secondaryCmdId = uuidv4();
        const secondaryParams = { ...deployParams, role: 'secondary' };
        await Command.create({
          commandId: secondaryCmdId,
          nodeId: secondaryNode.nodeId,
          command: 'deploy_site',
          params: secondaryParams,
          status: 'pending',
          createdBy: 'deployment-service',
        });
        io.to(`node:${secondaryNode.nodeId}`).emit('command:new', {
          commandId: secondaryCmdId,
          command: 'deploy_site',
          params: secondaryParams,
        });
      }

      // Dispatch to backup node if available
      if (backupNode) {
        const backupCmdId = uuidv4();
        const backupParams = { ...deployParams, role: 'backup' };
        await Command.create({
          commandId: backupCmdId,
          nodeId: backupNode.nodeId,
          command: 'deploy_site',
          params: backupParams,
          status: 'pending',
          createdBy: 'deployment-service',
        });
        io.to(`node:${backupNode.nodeId}`).emit('command:new', {
          commandId: backupCmdId,
          command: 'deploy_site',
          params: backupParams,
        });
      }
    }

    // 7. Update deployment status
    await Deployment.updateOne(
      { deploymentId },
      {
        $set: {
          status: 'dispatching',
          progress: 10,
        },
      }
    );

    // 8. Emit deployment update to admin panel
    if (io) {
      const updated = await Deployment.findOne({ deploymentId }).lean();
      io.to('admin').emit('deployment:update', updated);
    }

    // 9. Update website status with multi-node setup
    const websiteUpdate = {
      status: 'deploying',
      primaryNode: deployNode._id,
      activeNode: deployNode._id,
    };
    if (secondaryNode) websiteUpdate.secondaryNode = secondaryNode._id;
    if (backupNode) websiteUpdate.fallbackNode = backupNode._id;

    const nodeIdsToAdd = [deployNode._id];
    if (secondaryNode) nodeIdsToAdd.push(secondaryNode._id);
    if (backupNode) nodeIdsToAdd.push(backupNode._id);

    await Website.updateOne(
      { siteId: deployment.siteId },
      {
        $set: websiteUpdate,
        $addToSet: { assignedNodes: { $each: nodeIdsToAdd } },
      }
    );

    logger.info(`Deployment ${deploymentId} dispatched to primary:${deployNode.name}${secondaryNode ? ', secondary:' + secondaryNode.name : ''}${backupNode ? ', backup:' + backupNode.name : ''}`);

    return { deployment, node: deployNode, command: cmd };
  } catch (error) {
    logger.error(`Deployment processing failed: ${error.message}`);
    await failDeployment(deploymentId, error.message, 'PROCESSING_ERROR');
    return null;
  }
}

/**
 * Handle a deployment status report from a node.
 * Called when the node acknowledges the deploy command with a result.
 * Uses the reporting node's ID to update the correct nodeResults entry.
 */
async function handleDeploymentReport(deploymentId, report, reportingNodeId) {
  try {
    const { status, progress, message, containerId, containerName, port } = report;
    const updateFields = {};

    if (status === 'downloading') {
      updateFields.status = 'downloading';
      updateFields.progress = 25;
    } else if (status === 'building') {
      updateFields.status = 'building';
      updateFields.progress = 50;
      if (message) updateFields.buildLog = message;
    } else if (status === 'deploying') {
      updateFields.status = 'deploying';
      updateFields.progress = 75;
      if (message) updateFields.buildLog = message;
    } else if (status === 'active') {
      updateFields.status = 'active';
      updateFields.progress = 100;
      updateFields.completedAt = new Date();
      if (containerId) updateFields['containerInfo.containerId'] = containerId;
      if (containerName) updateFields['containerInfo.containerName'] = containerName;
      if (port) updateFields['containerInfo.exposedPort'] = port;
    } else if (status === 'failed') {
      updateFields.status = 'failed';
      updateFields.error = { message: message || 'Deployment failed on node', code: 'NODE_ERROR' };
      updateFields.completedAt = new Date();
    }

    if (progress !== undefined) updateFields.progress = Math.min(100, Math.max(0, progress));
    if (message && status !== 'failed') {
      updateFields.buildLog = message;
    }

    await Deployment.updateOne({ deploymentId }, { $set: updateFields });

    // Update the nodeResults entry for the reporting node
    if (reportingNodeId) {
      const deployment = await Deployment.findOne({ deploymentId }).lean();
      if (deployment && deployment.nodeResults) {
        const updatedResults = deployment.nodeResults.map(nr => {
          if (nr.nodeId === reportingNodeId) {
            return {
              ...nr,
              status: status || nr.status,
              containerId: containerId || nr.containerId,
              containerName: containerName || nr.containerName,
              port: port || nr.port,
              completedAt: status === 'active' || status === 'failed' ? new Date() : nr.completedAt,
              error: status === 'failed' ? (message || 'Unknown error') : nr.error,
              progress: progress !== undefined ? progress : nr.progress,
            };
          }
          return nr;
        });
        await Deployment.updateOne({ deploymentId }, { $set: { nodeResults: updatedResults } });
      }
    }

    // If deployment succeeded, update the website
    if (status === 'active') {
      const deployment = await Deployment.findOne({ deploymentId }).lean();
      if (deployment) {
        // Update node result in the deployment
        const nodeResults = (deployment.nodeResults || []).map((nr) => {
          if (nr.nodeId === deployment.assignedNodeId) {
            return {
              ...nr,
              status: 'active',
              containerId: containerId || nr.containerId,
              containerName: containerName || nr.containerName,
              port: port || nr.port,
              completedAt: new Date(),
            };
          }
          return nr;
        });

        await Deployment.updateOne(
          { deploymentId },
          { $set: { nodeResults } }
        );

        await Website.updateOne(
          { siteId: deployment.siteId },
          {
            $set: {
              status: 'active',
              deployedAt: new Date(),
              deployedBy: deployment.createdBy,
              healthStatus: 'unknown',
              activeNode: deployment.assignedNode,
              'ports.internal': deployment.containerInfo?.internalPort || 8080,
              'ports.http': deployment.containerInfo?.exposedPort || port,
            },
          }
        );

        // Register with the reverse proxy
        proxyService.registerSite(deployment.deploymentId)
          .then((registered) => {
            if (registered) {
              logger.info(`Site ${deployment.domain} registered with reverse proxy`);
            }
          })
          .catch((err) => logger.warn(`Proxy registration warning: ${err.message}`));

        logger.info(`Website ${deployment.domain} deployed successfully (v${deployment.version})`);
      }
    }

    // If deployment failed, mark website as failed too — but ONLY if no node succeeded
    if (status === 'failed') {
      const deployment = await Deployment.findOne({ deploymentId }).lean();
      if (deployment) {
        // Check if ANY node already reported success
        const anySuccess = deployment.nodeResults?.some(
          nr => nr.status === 'active' || nr.status === 'success'
        );
        if (!anySuccess) {
          await Deployment.updateOne(
            { deploymentId },
            { $set: { status: 'failed' } }
          );
          await Website.updateOne(
            { siteId: deployment.siteId },
            { $set: { status: 'failed' } }
          );

          await Alert.create({
            alertId: `alert_${uuidv4().split('-')[0]}`,
            type: 'website_down',
            severity: 'critical',
            message: `Deployment failed for ${deployment.domain}: ${message || 'Unknown error'}`,
            nodeId: deployment.assignedNodeId,
            nodeName: '',
            metadata: { deploymentId, siteId: deployment.siteId, version: deployment.version },
          });
        } else {
          logger.warn(`Deployment ${deploymentId} node ${reportingNodeId} failed, but another node already succeeded — keeping status as active`);
        }
      }
    }

    return await Deployment.findOne({ deploymentId }).lean();
  } catch (error) {
    logger.error(`Deployment report handling failed: ${error.message}`);
    return null;
  }
}

/**
 * Roll back a website to a previous deployment version.
 */
async function rollbackDeployment(siteId, targetVersion) {
  const targetDeployment = await Deployment.findOne({ siteId, version: targetVersion });
  if (!targetDeployment) {
    throw new Error(`Deployment version ${targetVersion} not found for site ${siteId}`);
  }

  // Create a new deployment that re-deploys the old source
  const newDeployment = await createDeployment({
    siteId: targetDeployment.siteId,
    domain: targetDeployment.domain,
    type: targetDeployment.type,
    source: targetDeployment.source,
    buildConfig: targetDeployment.buildConfig,
    createdBy: 'system (rollback)',
  });

  await Deployment.updateOne(
    { deploymentId: newDeployment.deploymentId },
    { $set: { rollbackOf: targetDeployment.deploymentId } }
  );

  return newDeployment;
}

/**
 * Mark a deployment as failed.
 */
async function failDeployment(deploymentId, message, code = 'UNKNOWN') {
  await Deployment.updateOne(
    { deploymentId },
    {
      $set: {
        status: 'failed',
        progress: 0,
        completedAt: new Date(),
        'error.message': message,
        'error.code': code,
      },
    }
  );

  // Also mark the website as failed
  const deployment = await Deployment.findOne({ deploymentId }).lean();
  if (deployment) {
    await Website.updateOne(
      { siteId: deployment.siteId },
      { $set: { status: 'failed' } }
    );
  }

  logger.error(`Deployment ${deploymentId} failed: ${message}`);
}

/**
 * Get deployment history for a site.
 */
async function getDeploymentHistory(siteId, limit = 20, offset = 0) {
  const [deployments, total] = await Promise.all([
    Deployment.find({ siteId })
      .sort({ version: -1 })
      .skip(offset)
      .limit(limit)
      .populate('assignedNode', 'nodeId name')
      .lean(),
    Deployment.countDocuments({ siteId }),
  ]);

  return { deployments, total };
}

module.exports = {
  createDeployment,
  processDeployment,
  handleDeploymentReport,
  rollbackDeployment,
  getDeploymentHistory,
  failDeployment,
};
