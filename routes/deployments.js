/**
 * Deployment routes
 *
 * Full deployment orchestration API.
 * Manages the lifecycle of website/application deployments
 * across the distributed node network.
 *
 * POST   /api/deployments/upload     — Upload a zip and deploy
 * POST   /api/deployments/git        — Deploy from a git repository
 * POST   /api/deployments/docker     — Deploy a Docker image
 * GET    /api/deployments            — List all deployments
 * GET    /api/deployments/:id        — Get deployment details
 * GET    /api/deployments/:id/download — Download deployment artifact (node auth)
 * GET    /api/deployments/:id/logs   — Get deployment build logs
 * POST   /api/deployments/:id/rollback — Rollback to a version
 * POST   /api/deployments/report     — Node reports deployment status
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const Deployment = require('../models/Deployment');
const Website = require('../models/Website');
const Node = require('../models/Node');
const { authenticateAdmin, authenticateNode, optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const deploymentService = require('../services/deploymentService');
const storageService = require('../services/storageService');
const schedulerService = require('../services/schedulerService');
const logger = require('../config/logger');

// ─── File upload configuration ───────────────────────────────────────────

const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB max
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.tar.gz', '.tgz'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip' || ext === '.tar.gz' || ext === '.tgz' || !ext) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are supported for upload'));
    }
  },
});

// ─── List all deployments (admin) ────────────────────────────────────────

/**
 * GET /api/deployments
 * List all deployments with pagination and filters
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { status, siteId, limit = 50, offset = 0 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (siteId) filter.siteId = siteId;

    // Client scope: only see own deployments
    if (req.clientId) {
      filter.clientId = req.clientId;
    } else if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const parseNum = (val, def) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? def : Math.min(Math.max(n, 0), 500);
    };

    const limitNum = parseNum(limit, 50);
    const offsetNum = parseNum(offset, 0);

    const [deployments, total] = await Promise.all([
      Deployment.find(filter)
        .sort({ createdAt: -1 })
        .skip(offsetNum)
        .limit(limitNum)
        .populate('assignedNode', 'nodeId name status')
        .lean(),
      Deployment.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: deployments.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      deployments,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Upload zip and deploy ───────────────────────────────────────────────

/**
 * POST /api/deployments/upload
 * Upload a zip file and deploy it as a website.
 * Body (multipart/form-data):
 *   - file: .zip file
 *   - domain: the domain to deploy to
 *   - type: static|nodejs|python|docker|custom
 *   - buildCommand: optional build command
 *   - outputDir: optional output directory
 */
router.post(
  '/upload',
  authenticateAdmin,
  auditMiddleware,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { domain, type, buildCommand, outputDir, installCommand } = req.body;

      if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
      }

      // Find or create website
      let website = await Website.findOne({ domain: domain.toLowerCase() });
      if (!website) {
        const siteId = `site_${uuidv4().split('-')[0]}`;
        website = await Website.create({
          siteId,
          domain: domain.toLowerCase(),
          type: type || 'static',
          status: 'deploying',
          source: {
            buildCommand: buildCommand || '',
            outputDir: outputDir || '',
          },
        });
        logger.info(`Website auto-created: ${domain} (${siteId})`);
      }

      // Create deployment record
      const deployment = await deploymentService.createDeployment({
        siteId: website.siteId,
        domain: website.domain,
        type: type || website.type || 'static',
        source: {
          type: 'upload',
          filename: req.file.originalname || 'artifact.zip',
          size: req.file.size,
        },
        buildConfig: {
          buildCommand: buildCommand || '',
          outputDir: outputDir || '',
          installCommand: installCommand || '',
        },
        createdBy: req.admin?.email || 'admin',
      });

      // Save uploaded file
      const fileInfo = await storageService.saveUploadedFile(
        deployment.deploymentId,
        req.file
      );

      // Update deployment with file info
      await Deployment.updateOne(
        { deploymentId: deployment.deploymentId },
        {
          $set: {
            'source.filePath': fileInfo.filePath,
            'source.checksum': fileInfo.checksum,
            'source.filename': fileInfo.filename,
            'source.size': fileInfo.size,
            status: 'processing',
          },          $push: {
            artifacts: {
              filename: fileInfo.filename,
              filePath: fileInfo.filePath,
              size: fileInfo.size,
              checksum: fileInfo.checksum,
              storageType: fileInfo.storageType,
              storageNodeId: fileInfo.storageNodeId,
              uploadedAt: new Date(),
            },
          },        }
      );

      // Extract archive for preview (non-blocking)
      storageService.extractArchive(deployment.deploymentId, fileInfo.filePath)
        .then(() => logger.debug(`Extracted ${deployment.deploymentId}`))
        .catch((err) => logger.warn(`Extraction warning: ${err.message}`));

      // Audit log
      await res.auditLog('deployment_created', 'website', website.siteId, {
        deploymentId: deployment.deploymentId,
        domain,
        type,
        filename: req.file.originalname,
        size: req.file.size,
      });

      // Trigger deployment processing — await so errors are reported
      const io = req.app.get('io');
      try {
        const result = await deploymentService.processDeployment(deployment.deploymentId, io);
        if (!result) {
          // Deployment failed — get the error from the record
          const failedDeploy = await Deployment.findOne({ deploymentId: deployment.deploymentId }).lean();
          return res.status(500).json({
            success: false,
            message: 'Deployment processing failed',
            error: failedDeploy?.error?.message || 'No available node found',
            deployment: deployment.toJSON(),
          });
        }
      } catch (procErr) {
        logger.error(`Deployment processing error: ${procErr.message}`);
        return res.status(500).json({
          success: false,
          message: 'Deployment processing failed',
          error: procErr.message,
          deployment: deployment.toJSON(),
        });
      }

      res.status(201).json({
        success: true,
        message: 'Deployment created and dispatched',
        deployment: deployment.toJSON(),
        website: website.toJSON(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Deploy from git ─────────────────────────────────────────────────────

/**
 * POST /api/deployments/git
 * Deploy a website from a git repository.
 */
router.post('/git', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { domain, type, repoUrl, branch, buildCommand, outputDir, installCommand } = req.body;

    if (!domain) return res.status(400).json({ error: 'Domain is required' });
    if (!repoUrl) return res.status(400).json({ error: 'Repository URL is required' });

    // Find or create website
    let website = await Website.findOne({ domain: domain.toLowerCase() });
    if (!website) {
      const siteId = `site_${uuidv4().split('-')[0]}`;
      website = await Website.create({
        siteId,
        domain: domain.toLowerCase(),
        type: type || 'static',
        status: 'deploying',
        source: { repoUrl, branch: branch || 'main', buildCommand, outputDir },
      });
    }

    const deployment = await deploymentService.createDeployment({
      siteId: website.siteId,
      domain: website.domain,
      type: type || website.type || 'static',
      source: {
        type: 'git',
        repoUrl,
        branch: branch || 'main',
      },
      buildConfig: {
        buildCommand: buildCommand || '',
        outputDir: outputDir || '',
        installCommand: installCommand || '',
      },
      createdBy: req.admin?.email || 'admin',
    });

    await res.auditLog('deployment_created', 'website', website.siteId, {
      deploymentId: deployment.deploymentId,
      domain,
      type,
      repoUrl,
      branch,
    });

    const io = req.app.get('io');
    deploymentService.processDeployment(deployment.deploymentId, io)
      .catch((err) => logger.error(`Deployment error: ${err.message}`));

    res.status(201).json({
      success: true,
      message: 'Git deployment created',
      deployment: deployment.toJSON(),
      website: website.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

// ─── Deploy Docker image ─────────────────────────────────────────────────

/**
 * POST /api/deployments/docker
 * Deploy a Docker image to a node.
 */
router.post('/docker', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { domain, dockerImage, dockerTag, type, internalPort, env } = req.body;

    if (!domain) return res.status(400).json({ error: 'Domain is required' });
    if (!dockerImage) return res.status(400).json({ error: 'Docker image is required' });

    let website = await Website.findOne({ domain: domain.toLowerCase() });
    if (!website) {
      const siteId = `site_${uuidv4().split('-')[0]}`;
      website = await Website.create({
        siteId,
        domain: domain.toLowerCase(),
        type: 'docker',
        status: 'deploying',
      });
    }

    const deployment = await deploymentService.createDeployment({
      siteId: website.siteId,
      domain: website.domain,
      type: 'docker',
      source: {
        type: 'docker',
        dockerImage,
        dockerTag: dockerTag || 'latest',
      },
      buildConfig: {},
      createdBy: req.admin?.email || 'admin',
    });

    // Update with extra docker params
    await Deployment.updateOne(
      { deploymentId: deployment.deploymentId },
      {
        $set: {
          'containerInfo.internalPort': internalPort || 8080,
        },
      }
    );

    const io = req.app.get('io');
    deploymentService.processDeployment(deployment.deploymentId, io)
      .catch((err) => logger.error(`Deployment error: ${err.message}`));

    res.status(201).json({
      success: true,
      message: 'Docker deployment created',
      deployment: deployment.toJSON(),
      website: website.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

// ─── Download deployment artifact (node auth) ────────────────────────────

/**
 * GET /api/deployments/:id/download
 * Download a deployment artifact (zip file).
 * Auth: Node API key (Bearer)
 * The node authenticates with its API key to download the file.
 */
router.get('/:id/download', authenticateNode, async (req, res, next) => {
  try {
    const deployment = await Deployment.findOne({ deploymentId: req.params.id }).lean();
    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    // Verify this node is authorized to download (primary, secondary, or backup)
    const allowedNodeIds = [
      deployment.assignedNodeId,
      ...(deployment.nodeResults || []).map(n => n.nodeId),
    ].filter(Boolean);
    
    if (allowedNodeIds.length > 0 && !allowedNodeIds.includes(req.node.nodeId)) {
      return res.status(403).json({ error: 'This deployment is not assigned to your node' });
    }

    const artifactInfo = storageService.getArtifactInfo(deployment);
    let filePath;
    try {
      filePath = await storageService.getArtifactPath(deployment.deploymentId, artifactInfo);
    } catch (err) {
      return res.status(404).json({ error: 'Deployment file not found: ' + err.message });
    }

    // Update deployment status
    await Deployment.updateOne(
      { deploymentId: deployment.deploymentId },
      { $set: { status: 'downloading', progress: 25 } }
    );

    const filename = artifactInfo.filename || 'artifact.zip';
    res.download(filePath, filename);
  } catch (error) {
    next(error);
  }
});

// ─── Get deployment details ──────────────────────────────────────────────

/**
 * GET /api/deployments/:id
 * Get full deployment details with logs.
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const deployment = await Deployment.findOne({ deploymentId: req.params.id })
      .populate('assignedNode', 'nodeId name status mode metrics')
      .lean();

    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    // Client scope: only own deployments
    if (req.clientId && deployment.clientId !== req.clientId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Also get the extracted file tree if available
    let fileTree = [];
    try {
      fileTree = storageService.getExtractedTree(deployment.deploymentId);
    } catch {
      // File tree not available
    }

    res.json({
      success: true,
      deployment,
      fileTree,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Get deployment logs ─────────────────────────────────────────────────

/**
 * GET /api/deployments/:id/logs
 * Get the build log for a deployment.
 */
router.get('/:id/logs', authenticateAdmin, async (req, res, next) => {
  try {
    const deployment = await Deployment.findOne({ deploymentId: req.params.id })
      .select('deploymentId buildLog status progress error')
      .lean();

    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    res.json({ success: true, log: deployment.buildLog || '', deployment });
  } catch (error) {
    next(error);
  }
});

// ─── Rollback deployment ─────────────────────────────────────────────────

/**
 * POST /api/deployments/:id/rollback
 * Roll back to a previous deployment version.
 */
router.post('/:id/rollback', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { version } = req.body;
    if (!version) {
      return res.status(400).json({ error: 'Target version is required' });
    }

    const deployment = await Deployment.findOne({ deploymentId: req.params.id }).lean();
    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    const newDeployment = await deploymentService.rollbackDeployment(
      deployment.siteId,
      parseInt(version)
    );

    // Process the rollback deployment
    const io = req.app.get('io');
    deploymentService.processDeployment(newDeployment.deploymentId, io)
      .catch((err) => logger.error(`Rollback error: ${err.message}`));

    await res.auditLog('deployment_rolled_back', 'website', deployment.siteId, {
      fromDeployment: deployment.deploymentId,
      toVersion: version,
      newDeploymentId: newDeployment.deploymentId,
    });

    res.json({
      success: true,
      message: `Rolling back to version ${version}`,
      deployment: newDeployment.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/deployments/redeploy
 * Re-deploy the last active deployment for a website.
 */
router.post('/redeploy', authenticateAdmin, auditMiddleware, async (req, res, next) => {
  try {
    const { deploymentId } = req.body;
    if (!deploymentId) return res.status(400).json({ error: 'deploymentId is required' });

    const oldDeployment = await Deployment.findOne({ deploymentId }).lean();
    if (!oldDeployment) return res.status(404).json({ error: 'Deployment not found' });

    const newDeployment = await deploymentService.createDeployment({
      siteId: oldDeployment.siteId,
      domain: oldDeployment.domain,
      type: oldDeployment.type,
      source: {
        type: oldDeployment.source?.type || 'upload',
        filename: oldDeployment.source?.filename || '',
        filePath: oldDeployment.source?.filePath || '',
        size: oldDeployment.source?.size || 0,
        checksum: oldDeployment.source?.checksum || '',
      },
      buildConfig: oldDeployment.buildConfig || {},
      createdBy: req.admin?.email || 'admin',
    });

    // If the old deployment has an artifact, copy it
    if (oldDeployment.source?.filePath) {
      const fs = require('fs');
      const path = require('path');
      const storageService = require('../services/storageService');
      const artifactInfo = storageService.getArtifactInfo(oldDeployment);
      try {
        const srcPath = await storageService.getArtifactPath(oldDeployment.deploymentId, artifactInfo);
        if (srcPath && fs.existsSync(srcPath)) {
          const storageInfo = await storageService.saveUploadedFile(
            newDeployment.deploymentId,
            { buffer: fs.readFileSync(srcPath), originalname: artifactInfo.filename || 'artifact.zip' }
          );
          await Deployment.updateOne(
            { deploymentId: newDeployment.deploymentId },
            {
              $set: {
                'source.filePath': storageInfo.filePath,
                'source.checksum': storageInfo.checksum,
                'source.filename': storageInfo.filename,
                'source.size': storageInfo.size,
              },
              $push: {
                artifacts: {
                  filename: storageInfo.filename,
                  filePath: storageInfo.filePath,
                  size: storageInfo.size,
                  checksum: storageInfo.checksum,
                  storageType: storageInfo.storageType,
                  storageNodeId: storageInfo.storageNodeId,
                  uploadedAt: new Date(),
                },
              },
            }
          );
        }
      } catch (copyErr) {
        logger.warn(`Could not copy artifact for re-deploy: ${copyErr.message}`);
      }
    }

    const io = req.app.get('io');
    deploymentService.processDeployment(newDeployment.deploymentId, io)
      .catch(err => logger.error(`Re-deploy error: ${err.message}`));

    res.status(201).json({
      success: true,
      message: 'Re-deployment created',
      deployment: newDeployment.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

// ─── Node reports deployment status ──────────────────────────────────────

/**
 * POST /api/deployments/report
 * Node reports the status of a deployment.
 * Auth: Node API key (Bearer)
 */
router.post('/report', authenticateNode, async (req, res, next) => {
  try {
    const { deploymentId, status, progress, message, containerId, containerName, port } = req.body;

    if (!deploymentId) {
      return res.status(400).json({ error: 'deploymentId is required' });
    }

    const updated = await deploymentService.handleDeploymentReport(deploymentId, {
      status, progress, message, containerId, containerName, port,
    }, req.node.nodeId);

    // Emit to admin panel
    const io = req.app.get('io');
    if (io && updated) {
      io.to('admin').emit('deployment:update', updated);
    }

    res.json({
      success: true,
      message: 'Deployment status updated',
      deployment: updated,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Error handling for multer ───────────────────────────────────────────

router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
  }
  if (err.message && err.message.includes('Only .zip files')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
