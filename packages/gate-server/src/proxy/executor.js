'use strict';

/**
 * Gate V3 — gate_exec Executor
 *
 * When an intent is approved and the destination has a vault config,
 * Gate performs the actual HTTP call itself. The agent never touches
 * the destination API or the credential.
 *
 * Flow:
 *   intent approved
 *     → vault.fetchCredential(destination)       fetch ephemeral
 *     → vault.buildAuth(secret, credDef, url)    inject auth headers
 *     → http/https.request(url, payload)         make the real call
 *     → POST /v1/executions/:id/report           record outcome
 *     → credential discarded from memory
 *
 * The agent polls GET /v1/executions/:id or uses a webhook to receive outcome.
 * Credential hash is logged for audit; raw secret is never logged.
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { fetchCredential, buildAuth, getExecuteConfig } = require('./vault');

const GATE_PORT     = parseInt(process.env.PORT || '3001');
const PROXY_API_KEY = process.env.PROXY_API_KEY;

// ── Internal Gate API call ──────────────────────────────────────────────────

function gateApiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1',
      port: GATE_PORT,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROXY_API_KEY}`,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Make the real HTTP call ─────────────────────────────────────────────────

function executeHttp(targetUrl, method, payload, authHeaders, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers = {
      'Content-Type': contentType || 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'User-Agent': 'Zehrava-Gate/0.3.0 (gate_exec)',
      ...authHeaders,
    };

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   method || 'POST',
      headers,
      rejectUnauthorized: true,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Report execution outcome back to Gate ───────────────────────────────────

async function reportOutcome(executionId, executionToken, outcome) {
  try {
    await gateApiCall('POST', `/v1/executions/${executionId}/report`, {
      execution_token: executionToken,
      status: outcome.succeeded ? 'succeeded' : 'failed',
      result: outcome.result,
      error: outcome.error || null,
    });
  } catch (e) {
    console.error('[executor] Failed to report outcome:', e.message);
  }
}

// ── Main: execute an approved intent ────────────────────────────────────────

/**
 * executeIntent — called when an intent is approved and destination has vault config.
 *
 * @param {Object} intent - the intent record (id, destination, payload, etc.)
 * @returns {Object} { succeeded, httpStatus, responseHint, credentialRef }
 */
async function executeIntent(intent) {
  const destination = intent.destination;
  const intentId    = intent.id || intent.intentId;

  console.log(`[executor] gate_exec: ${destination} for intent ${intentId}`);

  // 1. Fetch execution order from Gate
  let execOrder;
  try {
    const execResp = await gateApiCall('POST', `/v1/intents/${intentId}/execute`, {});
    if (execResp.status !== 200 && execResp.status !== 201) {
      throw new Error(`Gate execute returned ${execResp.status}: ${JSON.stringify(execResp.body)}`);
    }
    execOrder = execResp.body;
  } catch (e) {
    console.error(`[executor] Failed to get execution order for ${intentId}:`, e.message);
    return { succeeded: false, error: e.message };
  }

  const executionId    = execOrder.executionId;
  const executionToken = execOrder.execution_token;

  // 2. Fetch credential (ephemeral)
  let credResult;
  try {
    credResult = await fetchCredential(destination);
    if (!credResult) {
      const err = `No vault credential configured for ${destination}`;
      await reportOutcome(executionId, executionToken, { succeeded: false, error: err });
      return { succeeded: false, error: err };
    }
  } catch (e) {
    console.error(`[executor] Vault error for ${destination}:`, e.message);
    await reportOutcome(executionId, executionToken, { succeeded: false, error: e.message });
    return { succeeded: false, error: e.message };
  }

  const { secret, credDef } = credResult;
  const execConfig = getExecuteConfig(destination);
  if (!execConfig) {
    const err = `No execute config for ${destination}`;
    await reportOutcome(executionId, executionToken, { succeeded: false, error: err });
    return { succeeded: false, error: err };
  }

  // 3. Build auth + target URL
  const baseUrl = execConfig.url.replace('{secret}', secret);
  const { headers: authHeaders, url: targetUrl } = buildAuth(secret, credDef, baseUrl);

  // Log credential reference (hash), NEVER the raw secret
  const credHash = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
  console.log(`[executor] Using credential (sha256:${credHash}…) for ${destination}`);

  // 4. Make the real HTTP call
  let callResult;
  try {
    // intent.payload_path contains the stored payload content
    const payload = intent.payloadContent || intent.payload || '';
    callResult = await executeHttp(
      targetUrl,
      execConfig.method || 'POST',
      payload,
      authHeaders,
      execConfig.content_type
    );
  } catch (e) {
    console.error(`[executor] HTTP call failed to ${targetUrl}:`, e.message);
    await reportOutcome(executionId, executionToken, {
      succeeded: false,
      error: `Network error: ${e.message}`,
    });
    return { succeeded: false, error: e.message };
  }

  // 5. Determine success (2xx)
  const succeeded = callResult.statusCode >= 200 && callResult.statusCode < 300;
  const responseHint = callResult.body.slice(0, 200); // truncated — never log full response

  console.log(`[executor] ${destination} → HTTP ${callResult.statusCode} (${succeeded ? 'succeeded' : 'failed'})`);

  // 6. Report outcome to Gate
  await reportOutcome(executionId, executionToken, {
    succeeded,
    result: {
      http_status: callResult.statusCode,
      response_hint: responseHint,
      destination,
    },
    error: succeeded ? null : `HTTP ${callResult.statusCode}: ${responseHint.slice(0, 100)}`,
  });

  // 7. Credential is now out of scope — GC will collect it
  // (No explicit zero — JS doesn't support explicit memory zeroing)

  return {
    succeeded,
    httpStatus: callResult.statusCode,
    responseHint,
    credentialRef: `env:${credDef.secret_env || 'vault'}`,  // reference only
    executionId,
  };
}

module.exports = { executeIntent };
