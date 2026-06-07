/**
 * Storage service
 *
 * Manages deployment artifact storage on the local filesystem.
 * Handles file uploads, extraction, integrity verification,
 * and cleanup of old deployment artifacts.
 *
 * All deployment files are stored under: <project_root>/deployments/<deploymentId>/
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { createWriteStream, createReadStream } = require('fs');
const logger = require('../config/logger');

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

/**
 * Ensure the deployments directory exists.
 */
function ensureDeployDir(deploymentId) {
  const dir = path.join(DEPLOYMENTS_DIR, deploymentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get the filesystem path for a deployment's artifact directory.
 */
function getDeployDir(deploymentId) {
  return path.join(DEPLOYMENTS_DIR, deploymentId);
}

/**
 * Calculate SHA-256 checksum of a file.
 */
async function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Save an uploaded file to the deployment directory.
 * Returns { filePath, filename, size, checksum }
 */
async function saveUploadedFile(deploymentId, uploadedFile) {
  const dir = ensureDeployDir(deploymentId);
  const filename = uploadedFile.originalname || 'artifact.zip';
  const filePath = path.join(dir, filename);

  // Write the file
  if (uploadedFile.buffer) {
    fs.writeFileSync(filePath, uploadedFile.buffer);
  } else if (uploadedFile.path) {
    fs.copyFileSync(uploadedFile.path, filePath);
  } else {
    throw new Error('No file data provided');
  }

  const stats = fs.statSync(filePath);
  const checksum = await calculateChecksum(filePath);

  logger.debug(`Saved deployment file: ${filename} (${stats.size} bytes, sha256: ${checksum.slice(0, 16)}...)`);

  return {
    filePath,
    filename,
    size: stats.size,
    checksum,
  };
}

/**
 * Extract a zip archive into the deployment directory.
 * Returns the extraction path.
 */
async function extractArchive(deploymentId, filePath) {
  const dir = getDeployDir(deploymentId);
  const extractDir = path.join(dir, 'extracted');

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);
    logger.debug(`Extracted ${filePath} to ${extractDir}`);
  } catch (error) {
    logger.warn(`Failed to extract with adm-zip, trying unzipper: ${error.message}`);
    // Fallback: create dir and list contents
    fs.mkdirSync(extractDir, { recursive: true });
    // Try unzipper as fallback
    try {
      const unzipper = require('unzipper');
      await pipeline(
        createReadStream(filePath),
        unzipper.Extract({ path: extractDir })
      );
    } catch (err2) {
      logger.error(`Extraction failed: ${err2.message}`);
      throw new Error(`Failed to extract archive: ${err2.message}`);
    }
  }

  return extractDir;
}

/**
 * Get the contents of the extracted directory (file tree).
 */
function getExtractedTree(deploymentId) {
  const extractDir = path.join(getDeployDir(deploymentId), 'extracted');
  if (!fs.existsSync(extractDir)) return [];

  function walk(dir, relativePath = '') {
    const entries = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relPath = relativePath ? `${relativePath}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ name: item.name, path: relPath, type: 'directory', children: walk(fullPath, relPath) });
      } else {
        const stat = fs.statSync(fullPath);
        entries.push({ name: item.name, path: relPath, type: 'file', size: stat.size });
      }
    }
    return entries;
  }

  return walk(extractDir);
}

/**
 * Read a file from an extracted deployment (for preview/serving).
 */
function readExtractedFile(deploymentId, relativePath) {
  const filePath = path.join(getDeployDir(deploymentId), 'extracted', relativePath);
  // Security: prevent path traversal
  const resolved = path.resolve(filePath);
  const baseDir = path.resolve(path.join(getDeployDir(deploymentId), 'extracted'));
  if (!resolved.startsWith(baseDir)) {
    throw new Error('Invalid path');
  }
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved);
}

/**
 * Clean up all files for a deployment.
 */
function cleanupDeployment(deploymentId) {
  const dir = getDeployDir(deploymentId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.debug(`Cleaned up deployment files: ${deploymentId}`);
  }
}

/**
 * Get the total disk usage of the deployments directory in bytes.
 */
function getDeploymentsDiskUsage() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return 0;

  let totalSize = 0;
  function walkDir(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walkDir(fullPath);
      } else {
        totalSize += fs.statSync(fullPath).size;
      }
    }
  }

  walkDir(DEPLOYMENTS_DIR);
  return totalSize;
}

module.exports = {
  saveUploadedFile,
  extractArchive,
  getExtractedTree,
  readExtractedFile,
  cleanupDeployment,
  getDeploymentsDiskUsage,
  getDeployDir,
};
