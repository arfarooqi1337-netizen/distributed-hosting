/**
 * Controller API — Main server entry point
 *
 * Express + Socket.IO server for the distributed hosting platform.
 * Handles node registration, heartbeats, command dispatch,
 * website management, and background job orchestration.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const config = require('./config');
const logger = require('./config/logger');
const connectDatabase = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

// Routes
const nodeRoutes = require('./routes/nodes');
const websiteRoutes = require('./routes/websites');
const jobRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const auditRoutes = require('./routes/audit');
const deploymentRoutes = require('./routes/deployments');
const proxyRoutes = require('./routes/proxy');
const clientRoutes = require('./routes/clients');
const containerRoutes = require('./routes/containers');
const nodeOpsRoutes = require('./routes/nodeOps');

// Services
const { startTimeoutChecker } = require('./services/heartbeatTimeout');
const { startStatsRefresh } = require('./services/statsService');
const { startNodeHistorySnapshot } = require('./services/nodeHistoryService');
const { startHealthChecks } = require('./services/healthCheckService');
const proxyService = require('./services/proxyService');
const { startFailoverService } = require('./services/failoverService');
const { startDeploymentTimeoutChecker } = require('./services/deploymentTimeout');

// Models
const Admin = require('./models/Admin');

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: config.socket.corsOrigin.split(',').map(s => s.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Middleware ────────────────────────────────────────────────────────────────

// Security headers with strict CSP
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Required for React dev
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'], // Allow WebSocket
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
      },
    },
  })
);

// CORS — supports comma-separated origins
app.use(cors({
  origin: config.socket.corsOrigin.split(',').map(s => s.trim()),
  credentials: true,
}));

// Request logging
app.use(morgan('short', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Global rate limiting — relaxed in dev mode
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.isDev ? 10000 : config.rateLimit.max,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/nodes', nodeRoutes);
app.use('/api/websites', websiteRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/audit-logs', auditRoutes);
app.use('/api/deployments', deploymentRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/containers', containerRoutes);
app.use('/api/node-ops', nodeOpsRoutes);

// Pass io instance to routes
app.set('io', io);

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const NodeModel = require('./models/Node');

// Track authenticated node IDs per socket
const socketNodeMap = new Map();

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Authenticate and join admin room — requires valid JWT token
  socket.on('join:admin', (token) => {
    try {
      if (!token) {
        socket.emit('error', { message: 'Authentication required to join admin room' });
        return;
      }
      const decoded = jwt.verify(token, config.jwt.secret);
      socket.adminUser = decoded;
      socket.join('admin');
      logger.debug(`Socket ${socket.id} joined admin room (user: ${decoded.email})`);
      socket.emit('admin:joined', { success: true });
    } catch (error) {
      socket.emit('error', { message: 'Invalid or expired token' });
      logger.warn(`Socket ${socket.id} failed admin auth`);
    }
  });

  // Join node-specific room — requires valid API key sent as second parameter
  // Usage: socket.emit('join:node', nodeId, apiKey)
  socket.on('join:node', async (nodeId, apiKey) => {
    try {
      if (!nodeId || !apiKey) {
        socket.emit('error', { message: 'nodeId and apiKey are required to join node room' });
        return;
      }

      // Validate the API key
      const node = await NodeModel.findOne({ nodeId, apiKey });
      if (!node) {
        socket.emit('error', { message: 'Invalid node credentials' });
        logger.warn(`Socket ${socket.id} failed node auth for ${nodeId}`);
        return;
      }

      socket.join(`node:${nodeId}`);
      socketNodeMap.set(socket.id, nodeId);
      logger.debug(`Socket ${socket.id} authenticated and joined node room: ${nodeId}`);
      socket.emit('node:joined', { success: true, nodeId });
    } catch (error) {
      socket.emit('error', { message: 'Authentication failed' });
      logger.error(`Socket node auth error: ${error.message}`);
    }
  });

  socket.on('disconnect', () => {
    const nodeId = socketNodeMap.get(socket.id);
    if (nodeId) {
      logger.debug(`Node ${nodeId} disconnected (socket: ${socket.id})`);
      socketNodeMap.delete(socket.id);
    } else {
      logger.debug(`Client disconnected: ${socket.id}`);
    }
  });
});

// ─── Seed Initial Admin ───────────────────────────────────────────────────────

async function seedAdmin() {
  try {
    const existing = await Admin.findOne({ email: config.admin.email });
    if (!existing) {
      await Admin.create({
        email: config.admin.email,
        password: config.admin.password,
        role: 'superadmin',
        name: 'System Admin',
      });
      logger.info(`Default admin created: ${config.admin.email}`);
    }
  } catch (error) {
    logger.error('Failed to seed admin:', error.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Connect to database
    await connectDatabase();

    // Seed initial admin
    await seedAdmin();

    // Start background services
    const timeoutInterval = startTimeoutChecker(io);
    const statsInterval = startStatsRefresh(10000);
    const historyInterval = startNodeHistorySnapshot();
    const healthCheckInterval = startHealthChecks();

    // Start failover monitoring for multi-node websites
    const failoverInterval = startFailoverService(io);

    // Start deployment timeout checker — prevents stuck deployments
    const deployTimeoutInterval = startDeploymentTimeoutChecker(io);

    // Initialize reverse proxy (non-blocking — gracefully handles missing Caddy)
    if (config.proxy.enabled && config.proxy.autoStart) {
      proxyService.initProxy().then((started) => {
        if (started) {
          logger.info('Reverse proxy initialized successfully');
        } else {
          logger.warn('Reverse proxy not available — sites accessible via direct port only');
        }
      });
    }

    // Start HTTP server
    server.listen(config.port, () => {
      logger.info(`======================================`);
      logger.info(`Controller API v1.0.0`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Port: ${config.port}`);
      logger.info(`MongoDB: ${config.mongodb.uri.replace(/\/\/.+?:.+?@/, '//***:***@')}`);
      logger.info(`Socket.IO CORS: ${config.socket.corsOrigin}`);
      logger.info(`======================================`);
    });

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down gracefully...');
      clearInterval(timeoutInterval);
      clearInterval(statsInterval);
      clearInterval(historyInterval);
      clearInterval(healthCheckInterval);
      clearInterval(failoverInterval);
      io.close();
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}
//process.on('unhandledRejection', (reason, promise) => {
//  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
//  // Application specific logging, throwing an error, or other logic here
//});
start();
