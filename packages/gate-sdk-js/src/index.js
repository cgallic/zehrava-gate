/**
 * zehrava-gate — JS SDK
 * Write-path control plane for AI agents.
 *
 * Usage:
 *   const { Gate } = require('zehrava-gate')
 *   const gate = new Gate({ endpoint: 'http://localhost:4000', apiKey: 'gate_sk_...' })
 *   const p = await gate.propose({ payload: '...', destination: 'salesforce.import', policy: 'crm-low-risk' })
 *   // p.status → "approved" | "blocked" | "pending_approval" | "duplicate_blocked"
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

class Gate {
  constructor({ endpoint, apiKey }) {
    if (!endpoint) throw new Error('endpoint is required');
    if (!apiKey)   throw new Error('apiKey is required');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(`${this.endpoint}${path}`);
      const lib  = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type':  'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      };

      const req = lib.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.body   = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${raw}`));
          }
        });
      });

      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Submit an intent for policy evaluation.
   * @param {Object}  opts
   * @param {string}  opts.payload               - Content or file path
   * @param {string}  opts.destination           - Target system (e.g. 'salesforce.import')
   * @param {string}  opts.policy                - Policy ID (e.g. 'crm-low-risk')
   * @param {number}  [opts.recordCount]         - Batch size for threshold checks
   * @param {number}  [opts.estimatedValueUsd]   - Financial value (contributes to risk score)
   * @param {string[]}[opts.sensitivityTags]     - e.g. ['pii', 'financial']
   * @param {string}  [opts.idempotencyKey]      - Deduplicate retries
   * @param {string}  [opts.onBehalfOf]          - Orchestrator agent ID (multi-agent audit)
   * @param {string}  [opts.expiresIn]           - Approval window e.g. '1h', '30m'. Default: '1h'
   * @param {Object}  [opts.metadata]            - Arbitrary key/value pairs
   * @returns {Promise<{intentId, status, risk_score, risk_level, blockReason, expiresAt}>}
   *   status: "approved" | "blocked" | "pending_approval" | "duplicate_blocked"
   *   blockReason: set if status === "blocked" or "duplicate_blocked"
   */
  async propose({
    payload, destination, policy, recordCount, estimatedValueUsd,
    sensitivityTags, idempotencyKey, onBehalfOf, expiresIn = '1h', metadata
  } = {}) {
    return this._request('POST', '/v1/intents', {
      payload, destination, policy,
      recordCount, expiresIn, metadata,
      estimated_value_usd: estimatedValueUsd,
      sensitivity_tags:    sensitivityTags,
      idempotency_key:     idempotencyKey,
      on_behalf_of:        onBehalfOf,
    });
  }

  /**
   * Approve a pending intent.
   * @param {Object} opts
   * @param {string} opts.intentId
   * @returns {Promise<{status, approvedAt}>}
   */
  async approve({ intentId } = {}) {
    return this._request('POST', `/v1/intents/${intentId}/approve`, {});
  }

  /**
   * Reject a pending intent.
   * @param {Object} opts
   * @param {string} opts.intentId
   * @param {string} [opts.reason]
   * @returns {Promise<{status}>}
   */
  async reject({ intentId, reason } = {}) {
    return this._request('POST', `/v1/intents/${intentId}/reject`, { reason });
  }

  /**
   * Request a signed execution order for an approved intent.
   * Returns a one-time gex_ token (15 min TTL). Worker uses this to perform the write.
   * @param {Object} opts
   * @param {string} opts.intentId
   * @returns {Promise<{executionId, execution_token, intent_id, expires_at, mode}>}
   */
  async execute({ intentId } = {}) {
    return this._request('POST', `/v1/intents/${intentId}/execute`, {});
  }

  /**
   * Fetch full intent details including policy decision and current status.
   * @param {Object} opts
   * @param {string} opts.intentId
   * @returns {Promise<Object>}
   */
  async verify({ intentId } = {}) {
    return this._request('GET', `/v1/intents/${intentId}`);
  }

  /**
   * Register a webhook for intent state transitions (approved | rejected).
   * Note: JS SDK method coming in next release — use Python SDK or direct API for now.
   * @param {Object} opts
   * @param {string} opts.intentId
   * @param {string} opts.url
   * @param {string} [opts.secret] - Sent as X-Gate-Secret header
   */
  async registerWebhook({ intentId, url, secret } = {}) {
    return this._request('POST', '/v1/webhooks/register', { intentId, url, secret });
  }
}

module.exports = { Gate };
