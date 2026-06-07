/**
 * Request validation middleware using express-validator
 */

const { body, param, query, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
};

// --- Node validation rules ---

const validateNodeRegistration = [
  body('nodeId').isString().notEmpty().withMessage('nodeId is required'),
  body('name').isString().notEmpty().withMessage('name is required'),
  body('hostname').optional().isString(),
  body('hardware_info').optional().isObject(),
  handleValidationErrors,
];

const validateHeartbeat = [
  body('mode').isString().isIn(['IDLE', 'NORMAL', 'GAMING', 'LOW_NETWORK', 'OFFLINE']).withMessage('Invalid mode'),
  body('metrics').isObject().withMessage('metrics object required'),
  handleValidationErrors,
];

// --- Website validation rules ---

const validateCreateWebsite = [
  body('domain').isString().notEmpty().isLowercase().withMessage('Valid domain required'),
  body('type').optional().isIn(['static', 'nodejs', 'python', 'php', 'custom']),
  body('assignedNodeIds').optional().isArray(),
  handleValidationErrors,
];

// --- Job validation rules ---

const validateCreateJob = [
  body('type').isString().notEmpty().withMessage('Job type required'),
  body('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
  handleValidationErrors,
];

module.exports = {
  validateNodeRegistration,
  validateHeartbeat,
  validateCreateWebsite,
  validateCreateJob,
  handleValidationErrors,
};
