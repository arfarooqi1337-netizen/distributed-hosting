/**
 * Database connection manager
 *
 * Fixed version:
 * - First tries the original mongodb+srv:// URI exactly like MongoDB Compass.
 * - If Node.js DNS blocks SRV lookup, it manually resolves SRV + TXT records.
 * - Preserves Atlas options like authSource, replicaSet, tls, retryWrites.
 */

const mongoose = require('mongoose');
const dns = require('dns').promises;
const config = require('./index');
const logger = require('./logger');

/**
 * Hide MongoDB password before logging URI.
 */
function maskMongoUri(uri) {
  return uri.replace(
    /(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@/i,
    '$1$2:****@'
  );
}

/**
 * Parse mongodb+srv://username:password@host/database?query
 */
function parseMongoSrvUri(uri) {
  const match = uri.match(
    /^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/]+)\/([^?]+)(?:\?(.*))?$/i
  );

  if (!match) {
    throw new Error('Invalid mongodb+srv URI format');
  }

  return {
    username: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    host: match[3],
    dbName: match[4],
    queryString: match[5] || '',
  };
}

/**
 * Merge MongoDB query strings.
 * Later values override earlier values.
 */
function mergeQueryStrings(...queryStrings) {
  const params = new URLSearchParams();

  for (const query of queryStrings) {
    if (!query) continue;

    const cleanQuery = query.replace(/^\?/, '');
    const current = new URLSearchParams(cleanQuery);

    for (const [key, value] of current.entries()) {
      params.set(key, value);
    }
  }

  return params.toString();
}

/**
 * Try normal DNS first.
 * If Windows / ISP DNS blocks SRV, try Cloudflare and Google DNS.
 */
async function resolveWithDnsFallback(resolveFunction) {
  const originalServers = dns.getServers();

  try {
    return await resolveFunction();
  } catch (firstError) {
    logger.warn(
      `Default DNS resolution failed (${firstError.code || firstError.message}). Trying Cloudflare/Google DNS...`
    );

    dns.setServers(['1.1.1.1', '8.8.8.8']);

    try {
      return await resolveFunction();
    } finally {
      dns.setServers(originalServers);
    }
  }
}

/**
 * Convert mongodb+srv:// into direct mongodb:// only if Node cannot use SRV directly.
 *
 * Important:
 * MongoDB Atlas stores important options in TXT records.
 * Your old code only resolved SRV records and lost those TXT options.
 */
async function buildDirectAtlasUriFromSrv(srvUri) {
  const { username, password, host, dbName, queryString } = parseMongoSrvUri(srvUri);

  const srvRecords = await resolveWithDnsFallback(() =>
    dns.resolveSrv(`_mongodb._tcp.${host}`)
  );

  if (!srvRecords || srvRecords.length === 0) {
    throw new Error(`No MongoDB SRV records found for ${host}`);
  }

  let txtQueryString = '';

  try {
    const txtRecords = await resolveWithDnsFallback(() =>
      dns.resolveTxt(host)
    );

    txtQueryString = txtRecords.flat().join('&');
  } catch (txtError) {
    logger.warn(
      `Could not resolve MongoDB TXT records for ${host}: ${txtError.code || txtError.message}`
    );
  }

  const hosts = srvRecords
    .map((record) => `${record.name}:${record.port}`)
    .join(',');

  const finalQuery = mergeQueryStrings(
    txtQueryString,
    'tls=true',
    'authSource=admin',
    queryString
  );

  return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hosts}/${dbName}?${finalQuery}`;
}

/**
 * Connect to MongoDB with retry logic.
 */
const connectDatabase = async (retries = 3) => {
  const rawUri = config.mongodb.uri;

  if (!rawUri) {
    logger.error('MONGODB_URI is missing from environment/config');
    process.exit(1);
  }

  let fallbackUri = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let uriToUse = fallbackUri || rawUri;

      const conn = await mongoose.connect(uriToUse, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });

      logger.info(`MongoDB connected: ${conn.connection.host}`);
      logger.info(`MongoDB database: ${conn.connection.name}`);

      mongoose.connection.on('error', (err) => {
        logger.error('MongoDB runtime connection error:', err.message);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected.');
      });

      return conn;
    } catch (error) {
      const isSrvDnsError =
        rawUri.startsWith('mongodb+srv://') &&
        (
          error.message.includes('querySrv') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('ECONNREFUSED') ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ENOTFOUND'
        );

      if (isSrvDnsError && !fallbackUri) {
        logger.warn(
          'MongoDB SRV DNS failed in Node.js. Building direct Atlas URI using SRV + TXT records...'
        );

        try {
          fallbackUri = await buildDirectAtlasUriFromSrv(rawUri);
          logger.info(`MongoDB fallback URI prepared: ${maskMongoUri(fallbackUri)}`);

          // Retry immediately with fallback URI.
          attempt -= 1;
          continue;
        } catch (fallbackError) {
          logger.error(`Failed to build MongoDB fallback URI: ${fallbackError.message}`);
        }
      }

      logger.error(
        `MongoDB connection attempt ${attempt}/${retries} failed: ${error.message}`
      );

      if (attempt < retries) {
        const delay = 2000 * attempt;
        logger.info(`Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error('All MongoDB connection attempts failed. Exiting.');
        logger.error('Most likely causes:');
        logger.error('  1. App is not reading the same MONGODB_URI you tested in Compass');
        logger.error('  2. Node.js DNS cannot resolve Atlas SRV records on this network');
        logger.error('  3. Atlas TXT options were lost during URI conversion');
        logger.error('  4. Password has special characters and is not URL encoded');
        logger.error(`Current URI loaded by app: ${maskMongoUri(rawUri)}`);

        process.exit(1);
      }
    }
  }
};

module.exports = connectDatabase;