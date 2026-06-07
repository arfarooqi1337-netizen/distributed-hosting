/**
 * Configuration loader
 * Reads from environment variables with sensible defaults.
 * Production mode enforces strict security validation at startup.
 */

require('dotenv').config();

const crypto = require('crypto');

const nodeEnv = process.env.NODE_ENV || 'development';
const isDev = nodeEnv === 'development';
const isProduction = nodeEnv === 'production';

/**
 * Validate that a required secret is not a known default value.
 * In production, crash immediately if secrets are default/weak.
 */
function assertNotDefault(value, envVar, reason) {
  if (!value) {
    throw new Error(
      `${envVar} is not set. Create a .env file with:\n${envVar}=<your-value>`
    );
  }
  if (isProduction) {
    const knownDefaults = [
      'dev-secret-change-in-production',
      'dev-secret-change-in-production-32-chars-long!!',
      'changeme123',
      'my-secret-reg-key-change-me',
      'admin@example.com',
    ];
    if (knownDefaults.includes(value)) {
      throw new Error(
        `${envVar} is set to a known insecure default value. Change it immediately for production use.`
      );
    }
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv,
  isDev,
  isProduction,

  mongodb: {
    uri: (() => {
      const uri = process.env.MONGODB_URI;
      if (!uri) {
        throw new Error(
          'MONGODB_URI is not set. Create a .env file with:\nMONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/dbname'
        );
      }
      return uri;
    })(),
  },

  jwt: {
    secret: assertNotDefault(
      process.env.JWT_SECRET,
      'JWT_SECRET',
      'Must be a strong random string of at least 32 characters'
    ),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  masterRegistrationKey: assertNotDefault(
    process.env.MASTER_REGISTRATION_KEY,
    'MASTER_REGISTRATION_KEY',
    'Must be a strong random key. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  ),

  admin: {
    email: assertNotDefault(process.env.ADMIN_EMAIL, 'ADMIN_EMAIL', 'Must be a valid admin email'),
    password: assertNotDefault(
      process.env.ADMIN_PASSWORD,
      'ADMIN_PASSWORD',
      'Must be a strong password (min 12 chars with uppercase, lowercase, digit, special)'
    ),
  },

  socket: {
    corsOrigin: process.env.SOCKET_CORS_ORIGIN || 'http://localhost:5173',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    loginMax: parseInt(process.env.RATE_LIMIT_LOGIN_MAX, 10) || 10,
    loginWindowMs: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS, 10) || 900000,
  },

  heartbeat: {
    timeoutSeconds: parseInt(process.env.HEARTBEAT_TIMEOUT_SECONDS, 10) || 30,
    checkIntervalMs: parseInt(process.env.HEARTBEAT_CHECK_INTERVAL_MS, 10) || 10000,
  },

  logging: {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  },

  // HTTPS configuration (optional but recommended for production)
  https: {
    enabled: process.env.HTTPS_ENABLED === 'true' || false,
    cert: process.env.HTTPS_CERT_PATH || '',
    key: process.env.HTTPS_KEY_PATH || '',
  },

  // Reverse proxy configuration
  proxy: {
    enabled: process.env.PROXY_ENABLED !== 'false', // Enabled by default
    port: parseInt(process.env.PROXY_PORT, 10) || 2015,
    caddyPath: process.env.CADDY_PATH || 'caddy',
    autoStart: process.env.PROXY_AUTO_START !== 'false',
  },
};

module.exports = config;
