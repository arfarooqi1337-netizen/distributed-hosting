/**
 * Storage service
 *
 * Manages deployment artifact storage with pluggable backends:
 *   - local:        Save artifacts to the controller's local filesystem
 *   - backup_node:  Save artifacts to the Backup VPS file server
 *
 * Config via environment variables:
 *   ARTIFACT_STORAGE_DRIVER=local|backup_node
 *   ARTIFACT_BACKUP_NODE_ID=<backup-node-id>
 *   ARTIFACT_BACKUP_URL=http://<tailscale-ip>:9000
 *   ARTIFACT_STORAGE_PATH=/var/omega/artifacts
 *   ARTIFACT_API_KEY=<shared-secret-for-storage-server>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const logger = require('../config/logger');

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

const STORAGE_DRIVER = process.env.ARTIFACT_STORAGE_DRIVER || 'local';
const BACKUP_NODE_URL = process.env.ARTIFACT_BACKUP_URL || '';
const BACKUP_API_KEY = process.env.ARTIFACT_API_KEY || '';

function getStorageDriver() {
  return STORAGE_DRIVER;
}

function ensureLocalDir(deploymentId) {
  const dir = path.join(DEPLOYMENTS_DIR, deploymentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function calculateChecksum(data) {
  if (typeof data === 'string') {
    return new Promise(function(resolve, reject) {
      var hash = crypto.createHash('sha256');
      var stream = fs.createReadStream(data);
      stream.on('data', function(chunk) { hash.update(chunk); });
      stream.on('end', function() { resolve(hash.digest('hex')); });
      stream.on('error', reject);
    });
  }
  return crypto.createHash('sha256').update(data).digest('hex');
}

function backupNodeRequest(method, urlPath, bodyBuffer) {
  return new Promise(function(resolve, reject) {
    if (!BACKUP_NODE_URL) return reject(new Error('ARTIFACT_BACKUP_URL not configured'));
    var url = new URL(BACKUP_NODE_URL + urlPath);
    var options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: { 'Authorization': 'Bearer ' + BACKUP_API_KEY, 'Content-Type': 'application/octet-stream' },
      timeout: 30000,
    };
    if (bodyBuffer) options.headers['Content-Length'] = bodyBuffer.length;
    var req = http.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
        } else {
          reject(new Error('Backup storage error ' + res.statusCode + ': ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Backup storage timeout')); });
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function saveUploadedFile(deploymentId, uploadedFile) {
  var buffer = uploadedFile.buffer || (uploadedFile.path ? fs.readFileSync(uploadedFile.path) : null);
  if (!buffer) throw new Error('No file data provided');
  var filename = uploadedFile.originalname || 'artifact.zip';
  var checksum = await calculateChecksum(buffer);
  var size = buffer.length;

  if (STORAGE_DRIVER === 'backup_node') {
    logger.info('Saving artifact to backup node: ' + deploymentId + '/' + filename + ' (' + size + ' bytes)');
    await backupNodeRequest('PUT', '/artifacts/' + deploymentId + '/' + filename, buffer);
    var storageNodeId = process.env.ARTIFACT_BACKUP_NODE_ID || '';
    return { filePath: '/var/omega/artifacts/' + deploymentId + '/' + filename, filename: filename, size: size, checksum: checksum, storageType: 'backup_node', storageNodeId: storageNodeId };
  }

  var dir = ensureLocalDir(deploymentId);
  var filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return { filePath: filePath, filename: filename, size: size, checksum: checksum, storageType: 'local', storageNodeId: '' };
}

async function getArtifactPath(deploymentId, artifactInfo) {
  var st = artifactInfo.storageType || 'local';
  var fn = artifactInfo.filename || 'artifact.zip';

  if (st === 'backup_node') {
    var localDir = ensureLocalDir(deploymentId);
    var localPath = path.join(localDir, fn);
    if (fs.existsSync(localPath)) return localPath;
    // Download from backup VPS
    var url = new URL(BACKUP_NODE_URL + '/artifacts/' + deploymentId + '/' + fn);
    return new Promise(function(resolve, reject) {
      var destStream = fs.createWriteStream(localPath);
      http.get(url, { headers: { 'Authorization': 'Bearer ' + BACKUP_API_KEY } }, function(res) {
        if (res.statusCode !== 200) { reject(new Error('Download failed: ' + res.statusCode)); return; }
        res.pipe(destStream);
        res.on('end', function() { resolve(localPath); });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  var localPath = artifactInfo.filePath || path.join(DEPLOYMENTS_DIR, deploymentId, fn);
  if (!fs.existsSync(localPath)) throw new Error('Artifact not found: ' + localPath);
  return localPath;
}

function getArtifactInfo(deployment) {
  if (deployment.artifacts && deployment.artifacts.length > 0) return deployment.artifacts[0];
  return { filename: deployment.source?.filename || 'artifact.zip', filePath: deployment.filePath || '', size: deployment.source?.size || 0, checksum: deployment.source?.checksum || '', storageType: 'local', storageNodeId: '' };
}

/**
 * Extract a deployed artifact zip for preview.
 * Non-critical — failures are logged but not thrown.
 */
async function extractArchive(deploymentId, zipPath) {
  try {
    var AdmZip = require('adm-zip');
    var extractDir = path.join(DEPLOYMENTS_DIR, deploymentId, 'extracted');
    if (fs.existsSync(extractDir)) return;
    fs.mkdirSync(extractDir, { recursive: true });
    var zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    logger.debug('Extracted ' + deploymentId + ' to ' + extractDir);
  } catch (err) {
    logger.warn('Extraction skipped for ' + deploymentId + ': ' + err.message);
  }
}

/**
 * Get the extracted file tree for a deployment.
 */
function getExtractedTree(deploymentId) {
  var extractDir = path.join(DEPLOYMENTS_DIR, deploymentId, 'extracted');
  if (!fs.existsSync(extractDir)) return [];
  var result = [];
  function walk(dir, prefix) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var e of entries) {
      var fullPath = path.join(dir, e.name);
      var relPath = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) {
        result.push({ name: relPath + '/', type: 'directory' });
        walk(fullPath, relPath);
      } else {
        var stat = fs.statSync(fullPath);
        result.push({ name: relPath, type: 'file', size: stat.size });
      }
    }
  }
  walk(extractDir, '');
  return result;
}

module.exports = { saveUploadedFile: saveUploadedFile, getArtifactPath: getArtifactPath, getArtifactInfo: getArtifactInfo, getStorageDriver: getStorageDriver, calculateChecksum: calculateChecksum, extractArchive: extractArchive, getExtractedTree: getExtractedTree };
