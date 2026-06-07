/**
 * Job routes
 *
 * Manage background compute jobs on the network.
 * GET    /api/jobs         - List jobs
 * POST   /api/jobs         - Create a new job
 * GET    /api/jobs/:jobId  - Get job details
 * PATCH  /api/jobs/:jobId  - Update job (cancel, retry)
 * POST   /api/jobs/assign  - Auto-assign a pending job to best node
 * POST   /api/jobs/report  - Agent reports job result
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const Job = require('../models/Job');
const Node = require('../models/Node');
const { authenticateAdmin, authenticateNode } = require('../middleware/auth');
const { validateCreateJob } = require('../middleware/validation');
const logger = require('../config/logger');

/**
 * GET /api/jobs
 * List all jobs with optional filters and pagination
 */
router.get('/', authenticateAdmin, async (req, res, next) => {
  try {
    const { status, type, priority, limit, offset } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (priority) filter.priority = priority;

    const parseNum = (val, def) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? def : Math.min(Math.max(n, 0), 500);
    };

    const limitNum = parseNum(limit, 50);
    const offsetNum = parseNum(offset, 0);

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .populate('assignedNode', 'nodeId name status score')
        .sort({ createdAt: -1 })
        .skip(offsetNum)
        .limit(limitNum)
        .lean(),
      Job.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: jobs.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      jobs,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jobs
 * Create a new background job
 */
router.post('/', authenticateAdmin, validateCreateJob, async (req, res, next) => {
  try {
    const { type, priority, input, estimatedCpu, estimatedRamMb, estimatedDurationSec, tags } = req.body;

    const jobId = `job_${uuidv4().split('-')[0]}`;

    const job = await Job.create({
      jobId,
      type,
      priority: priority || 'low',
      input: input || {},
      estimatedCpu: estimatedCpu || 10,
      estimatedRamMb: estimatedRamMb || 128,
      estimatedDurationSec: estimatedDurationSec || 60,
      tags: tags || [],
      status: 'pending',
    });

    logger.info(`Job created: ${type} (${jobId})`);

    // Try to auto-assign
    const assignment = await autoAssignJob(job);

    res.status(201).json({
      success: true,
      job: job.toJSON(),
      assigned: assignment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jobs/assign
 * Auto-assign pending jobs to best compute nodes
 */
router.post('/assign', authenticateAdmin, async (req, res, next) => {
  try {
    const pendingJobs = await Job.find({ status: 'pending' }).sort({ priority: -1, createdAt: 1 });

    let assigned = 0;
    for (const job of pendingJobs) {
      const result = await autoAssignJob(job);
      if (result) assigned++;
    }

    res.json({ success: true, assigned, total: pendingJobs.length });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jobs/report
 * Agent reports a job result
 * Auth: Node API key
 */
router.post('/report', authenticateNode, async (req, res, next) => {
  try {
    const { jobId, status, output, progress, error: jobError } = req.body;

    const job = await Job.findOne({ jobId });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const updateFields = {};
    if (status) {
      updateFields.status = status;
      if (status === 'running') updateFields.startedAt = new Date();
      if (status === 'completed') {
        updateFields.completedAt = new Date();
        updateFields.progress = 100;
      }
      if (status === 'failed') {
        updateFields.error = {
          message: jobError?.message || 'Unknown error',
          stack: jobError?.stack || '',
        };
      }
    }
    if (output) updateFields.output = output;
    if (progress !== undefined) updateFields.progress = Math.min(100, Math.max(0, progress));

    const updatedJob = await Job.findOneAndUpdate(
      { jobId },
      { $set: updateFields },
      { new: true }
    );

    // Emit update
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('job:update', updatedJob.toJSON());
    }

    res.json({ success: true, job: updatedJob.toJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/jobs/:jobId
 * Update a job (cancel, retry)
 */
router.patch('/:jobId', authenticateAdmin, async (req, res, next) => {
  try {
    const { status: newStatus } = req.body;

    if (newStatus === 'cancelled') {
      const job = await Job.findOneAndUpdate(
        { jobId: req.params.jobId, status: { $in: ['pending', 'assigned', 'running'] } },
        { $set: { status: 'cancelled', completedAt: new Date() } },
        { new: true }
      );

      if (!job) {
        return res.status(404).json({ error: 'Job not found or already completed' });
      }

      logger.info(`Job cancelled: ${job.jobId}`);
      return res.json({ success: true, job: job.toJSON() });
    }

    if (newStatus === 'retry') {
      const job = await Job.findOneAndUpdate(
        { jobId: req.params.jobId, status: 'failed' },
        {
          $set: {
            status: 'pending',
            assignedNode: null,
            assignedAt: null,
            progress: 0,
            error: { message: '', stack: '' },
          },
          $inc: { retryCount: 1 },
        },
        { new: true }
      );

      if (!job) {
        return res.status(404).json({ error: 'Failed job not found' });
      }

      return res.json({ success: true, job: job.toJSON() });
    }

    res.status(400).json({ error: 'Invalid status update' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jobs/:jobId
 * Get job details
 */
router.get('/:jobId', authenticateAdmin, async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId })
      .populate('assignedNode', 'nodeId name status score')
      .lean();

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
});

/**
 * Auto-assign a job to the best available compute node
 */
async function autoAssignJob(job) {
  // Find best compute node
  const bestNode = await Node.findOne({
    type: 'COMPUTE_NODE',
    status: 'online',
    mode: { $in: ['IDLE', 'NORMAL'] },
    'metrics.cpuPercent': { $lt: 60 },
    'metrics.ramPercent': { $lt: 70 },
  }).sort({ computeScore: -1 });

  if (!bestNode) {
    // Try any online node
    const fallbackNode = await Node.findOne({
      status: 'online',
      mode: { $in: ['IDLE', 'NORMAL'] },
    }).sort({ score: -1 });

    if (!fallbackNode) {
      logger.debug(`No available node to assign job ${job.jobId}`);
      return null;
    }

    await Job.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          status: 'assigned',
          assignedNode: fallbackNode._id,
          assignedAt: new Date(),
        },
      }
    );

    return { nodeId: fallbackNode.nodeId, name: fallbackNode.name };
  }

  await Job.updateOne(
    { jobId: job.jobId },
    {
      $set: {
        status: 'assigned',
        assignedNode: bestNode._id,
        assignedAt: new Date(),
      },
    }
  );

  return { nodeId: bestNode.nodeId, name: bestNode.name };
}

module.exports = router;
