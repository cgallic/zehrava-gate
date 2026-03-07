/**
 * @zehrava/gate
 * Safe commit layer for AI agents.
 *
 * Usage:
 *   const { Gate } = require('@zehrava/gate')
 *   const gate = new Gate({ endpoint: 'http://localhost:3001', apiKey: 'gate_sk_...' })
 *   const proposal = await gate.propose({ payload: './leads.csv', destination: 'salesforce.import', policy: 'crm-low-risk' })
 *   console.log(proposal.status) // approved | pending_approval | blocked
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

class Gate {
  constructor({ endpoint, apiKey }) {
    if (!endpoint) throw new Error('endpoint is required');
    if (!apiKey) throw new Error('apiKey is required');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.endpoint}${path}`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const data = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      };

      const req = lib.request(options, (res) => {
        let rawData = '';
        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            if (res.statusCode >= 400) {
              const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${rawData}`));
          }
        });
      });

      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Propose an agent output for policy evaluation and approval.
   * @param {Object} opts
   * @param {string} opts.payload - File path, content, or base64
   * @param {string} opts.destination - Target system (e.g. 'salesforce.import')
   * @param {string} opts.policy - Policy ID (e.g. 'crm-low-risk')
   * @param {string} [opts.expiresIn] - Expiry (e.g. '1h', '30m'). Default: '1h'
   * @param {number} [opts.recordCount] - Number of records for threshold checks
   * @param {Object} [opts.metadata] - Additional context
   * @returns {Promise<{proposalId, status, blockReason, expiresAt}>}
   */
  async propose({ payload, destination, policy, expiresIn = '1h', recordCount, metadata } = {}) {
    return this._request('POST', '/v1/propose', {
      payload, destination, policy, expiresIn, recordCount, metadata
    });
  }

  /**
   * Approve a pending proposal.
   * @param {Object} opts
   * @param {string} opts.proposalId
   * @returns {Promise<{status, deliveryToken}>}
   */
  async approve({ proposalId } = {}) {
    return this._request('POST', '/v1/approve', { proposalId });
  }

  /**
   * Reject a pending proposal.
   * @param {Object} opts
   * @param {string} opts.proposalId
   * @param {string} [opts.reason]
   * @returns {Promise<{status, reason}>}
   */
  async reject({ proposalId, reason } = {}) {
    return this._request('POST', '/v1/reject', { proposalId, reason });
  }

  /**
   * Get a one-time delivery URL for an approved proposal.
   * @param {Object} opts
   * @param {string} opts.proposalId
   * @returns {Promise<{url, deliveryToken, expiresAt}>}
   */
  async deliver({ proposalId } = {}) {
    return this._request('POST', '/v1/deliver', { proposalId });
  }

  /**
   * Get full proposal details + audit trail.
   * @param {Object} opts
   * @param {string} opts.proposalId
   * @returns {Promise<Object>}
   */
  async verify({ proposalId } = {}) {
    return this._request('GET', `/v1/proposals/${proposalId}`);
  }
}

module.exports = { Gate };
