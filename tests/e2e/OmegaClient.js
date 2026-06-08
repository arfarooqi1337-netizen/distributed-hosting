/**
 * Omega E2E Test Client
 * Wraps the Controller API for E2E testing.
 */

const axios = require('axios');

class OmegaClient {
  constructor(baseURL) {
    this.api = axios.create({
      baseURL,
      timeout: 10000,
      validateStatus: () => true,
    });
    this.token = null;
    this.adminHeaders = {};
    this.testSiteId = null;
    this.testDeploymentId = null;
  }

  async login(email, password) {
    const res = await this.api.post('/api/admin/login', { email, password });
    if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.data)}`);
    this.token = res.data.token;
    this.adminHeaders = { Authorization: `Bearer ${this.token}` };
    return res.data;
  }

  async getNodes() {
    const res = await this.api.get('/api/nodes', { headers: this.adminHeaders });
    return res.data;
  }

  async deployStatic(domain, zipPath) {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(zipPath));
    form.append('domain', domain);
    form.append('type', 'static');

    const res = await this.api.post('/api/deployments/upload', form, {
      headers: { ...this.adminHeaders, ...form.getHeaders() },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return res.data;
  }

  async getDeployment(id) {
    const res = await this.api.get(`/api/deployments/${id}`, { headers: this.adminHeaders });
    return res.data;
  }

  async getWebsite(siteId) {
    const res = await this.api.get(`/api/websites/${siteId}`, { headers: this.adminHeaders });
    return res.data;
  }

  async waitForDeployment(deploymentId, timeoutMs = 180000) {
    const pollInterval = 3000;
    let waited = 0;
    while (waited < timeoutMs) {
      const dep = await this.getDeployment(deploymentId);
      if (dep.deployment?.status === 'active') return dep;
      if (dep.deployment?.status === 'failed') throw new Error(`Deployment failed: ${dep.deployment?.error?.message || 'unknown'}`);
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;
    }
    throw new Error(`Deployment timed out after ${timeoutMs}ms`);
  }

  async getDashboard() {
    const res = await this.api.get('/api/admin/stats', { headers: this.adminHeaders });
    return res.data;
  }

  async getProxyStatus() {
    const res = await this.api.get('/api/proxy/status', { headers: this.adminHeaders });
    return res.data;
  }

  async getContainers(nodeId) {
    const res = await this.api.get(`/api/containers/${nodeId}`, { headers: this.adminHeaders });
    return res.data;
  }

  async getContainerLogs(nodeId, containerId) {
    const res = await this.api.post(`/api/containers/${nodeId}/logs`,
      { containerId, tail: 50 },
      { headers: this.adminHeaders, timeout: 30000 }
    );
    return res.data;
  }

  async rollback(deploymentId, version) {
    const res = await this.api.post(`/api/deployments/${deploymentId}/rollback`,
      { version },
      { headers: this.adminHeaders }
    );
    return res.data;
  }
}

module.exports = OmegaClient;
