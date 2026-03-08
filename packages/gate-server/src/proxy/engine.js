'use strict';

/**
 * Gate V3 — Forward Proxy Engine (Phase 1: HTTP)
 *
 * Intercepts all outbound HTTP requests. For each:
 *   1. Look up destination + policy from registry
 *   2. Submit intent to Gate API (localhost:PORT/v1/intents)
 *   3. Three outcomes:
 *      - approved    → proxy request to real destination, return actual response
 *      - blocked     → 403 with JSON reason
 *      - pending     → 202 with X-Gate-Intent-Id + Retry-After
 *
 * Retry flow:
 *   Agent resends the same request with header X-Gate-Intent-Id: int_xxx
 *   Proxy checks intent status → if approved, proxies; if still pending, 202 again; if rejected, 403
 *
 * HTTPS CONNECT:
 *   Phase 1: tunnels CONNECT blindly (no TLS intercept — Phase 2)
 *   To see what's tunneled, agents must use plain HTTP to Gate proxy
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { lookup, extractRecordCount } = require('./registry');

const GATE_PORT = parseInt(process.env.PORT || '3001');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '4001');
// Internal API key for proxy → Gate API calls (a special system key)
const PROXY_API_KEY = process.env.PROXY_API_KEY || null;

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
      res.on('data', chunk => data += chunk);
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

// ── Proxy the request to its real destination ───────────────────────────────

function proxyRequest(clientReq, clientRes, targetUrl, rawBody) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Strip proxy-specific headers before forwarding
  const forwardHeaders = { ...clientReq.headers };
  delete forwardHeaders['proxy-connection'];
  delete forwardHeaders['proxy-authorization'];
  delete forwardHeaders['x-gate-intent-id'];
  forwardHeaders['host'] = parsed.hostname + (parsed.port ? ':' + parsed.port : '');

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: forwardHeaders,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] Forward error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: 'upstream_error', message: err.message }));
    }
  });

  if (rawBody && rawBody.length) proxyReq.write(rawBody);
  proxyReq.end();
}

// ── Read full request body ───────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ── Main request handler ────────────────────────────────────────────────────

async function handleRequest(clientReq, clientRes) {
  // Check for retry with existing intent ID
  const existingIntentId = clientReq.headers['x-gate-intent-id'];

  // Determine target URL (forward proxy requests have full URL in path)
  let targetUrl = clientReq.url;
  if (!targetUrl.startsWith('http')) {
    // Relative path — reconstruct from Host header
    const host = clientReq.headers.host || 'localhost';
    targetUrl = `http://${host}${targetUrl}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    clientRes.writeHead(400);
    clientRes.end(JSON.stringify({ error: 'invalid_url' }));
    return;
  }

  const hostname = parsedUrl.hostname;
  const urlPath = parsedUrl.pathname;

  // Look up destination in registry
  const destConfig = lookup(hostname, urlPath);

  // Passthrough (localhost, internal) — forward immediately
  if (destConfig.passthrough) {
    const rawBody = await readBody(clientReq);
    proxyRequest(clientReq, clientRes, targetUrl, rawBody);
    return;
  }

  // Read body for all non-passthrough requests
  const rawBody = await readBody(clientReq);
  const bodyStr = rawBody.toString('utf8');

  // Hard block from registry (unknown + block:true)
  if (destConfig.block && !destConfig.destination) {
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: 'destination_blocked',
      message: `Destination not in allowlist: ${hostname}`,
      hostname,
    }));
    return;
  }

  // No API key configured — can't submit intents, fail closed
  if (!PROXY_API_KEY) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: 'proxy_not_configured',
      message: 'PROXY_API_KEY not set. Gate proxy cannot submit intents without an API key.',
    }));
    return;
  }

  // ── Retry path: agent resends with X-Gate-Intent-Id ──────────────────────
  if (existingIntentId) {
    let intentResp;
    try {
      intentResp = await gateApiCall('GET', `/v1/intents/${existingIntentId}`);
    } catch (e) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'gate_unreachable', message: e.message }));
      return;
    }

    const intent = intentResp.body;
    const status = intent.status;

    if (status === 'approved') {
      // Approved — proxy the request now
      console.log(`[proxy] Intent ${existingIntentId} approved — forwarding ${clientReq.method} ${hostname}${urlPath}`);
      proxyRequest(clientReq, clientRes, targetUrl, rawBody);
      return;
    }

    if (status === 'pending_approval') {
      clientRes.writeHead(202, {
        'Content-Type': 'application/json',
        'X-Gate-Intent-Id': existingIntentId,
        'Retry-After': '30',
      });
      clientRes.end(JSON.stringify({
        status: 'pending_approval',
        intentId: existingIntentId,
        message: 'Waiting for human approval. Retry with X-Gate-Intent-Id header.',
        dashboard: `http://localhost:${GATE_PORT}/dashboard`,
      }));
      return;
    }

    // rejected / blocked / expired
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status,
      intentId: existingIntentId,
      blockReason: intent.blockReason || `Intent ${status}`,
    }));
    return;
  }

  // ── Fresh request — submit intent to Gate ────────────────────────────────

  // Try to extract record count from body
  let recordCount;
  if (destConfig.extract_records && bodyStr) {
    try {
      const parsed = JSON.parse(bodyStr);
      recordCount = extractRecordCount(parsed, destConfig.extract_records);
    } catch { /* not JSON, no count */ }
  }

  // Build payload hint (first 400 chars, no secrets)
  const payloadHint = bodyStr.slice(0, 400) || `${clientReq.method} ${urlPath}`;

  const intentBody = {
    payload: payloadHint,
    destination: destConfig.destination || `${hostname}.http`,
    policy: destConfig.policy || 'crm-low-risk',
    recordCount,
    metadata: {
      proxy: true,
      method: clientReq.method,
      host: hostname,
      path: urlPath,
      content_type: clientReq.headers['content-type'] || null,
      user_agent: clientReq.headers['user-agent'] || null,
    },
  };

  // Override require_approval if registry specifies always
  if (destConfig.require_approval === 'always') {
    intentBody.require_approval = 'always';
  }

  let intentResp;
  try {
    intentResp = await gateApiCall('POST', '/v1/intents', intentBody);
  } catch (e) {
    // Gate unreachable — fail closed
    console.error('[proxy] Gate API unreachable — failing closed:', e.message);
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: 'gate_unreachable',
      message: 'Gate API unreachable. Failing closed — request not forwarded.',
    }));
    return;
  }

  const intent = intentResp.body;

  // Duplicate blocked
  if (intentResp.status === 409) {
    clientRes.writeHead(409, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status: 'duplicate_blocked',
      intentId: intent.intentId,
      blockReason: intent.blockReason,
    }));
    return;
  }

  const intentStatus = intent.status;
  const intentId = intent.intentId || intent.proposalId;

  console.log(`[proxy] ${clientReq.method} ${hostname}${urlPath} → intent ${intentId} (${intentStatus})`);

  if (intentStatus === 'approved') {
    // Auto-approved — forward immediately
    proxyRequest(clientReq, clientRes, targetUrl, rawBody);
    return;
  }

  if (intentStatus === 'blocked' || intentStatus === 'duplicate_blocked') {
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status: intentStatus,
      intentId,
      blockReason: intent.blockReason,
      destination: destConfig.destination,
      policy: destConfig.policy,
    }));
    return;
  }

  if (intentStatus === 'pending_approval') {
    clientRes.writeHead(202, {
      'Content-Type': 'application/json',
      'X-Gate-Intent-Id': intentId,
      'Retry-After': '30',
    });
    clientRes.end(JSON.stringify({
      status: 'pending_approval',
      intentId,
      message: 'Intent queued for human approval. Resend request with X-Gate-Intent-Id header after approval.',
      dashboard: `http://localhost:${GATE_PORT}/dashboard`,
      retryAfterSeconds: 30,
    }));
    return;
  }

  // Unexpected status — fail closed
  clientRes.writeHead(502, { 'Content-Type': 'application/json' });
  clientRes.end(JSON.stringify({ error: 'unexpected_gate_status', status: intentStatus, intentId }));
}

// ── HTTPS CONNECT handler ─────────────────────────────────────────────────────
// If GATE_TLS_INTERCEPT=true: full MITM — Gate reads and governs HTTPS traffic
// Otherwise: blind TCP tunnel passthrough (Phase 1 behavior)

function handleConnect(req, clientSocket, head) {
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  if (process.env.GATE_TLS_INTERCEPT === 'true') {
    const { handleConnectMitm } = require('./mitm');
    handleConnectMitm(req, clientSocket, head);
    return;
  }

  // Passthrough (TLS intercept disabled)
  console.log(`[proxy] CONNECT tunnel ${hostname}:${targetPort} (passthrough — set GATE_TLS_INTERCEPT=true to intercept)`);

  const serverSocket = require('net').connect(targetPort, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (err) => {
    console.error(`[proxy] CONNECT error ${hostname}:${targetPort}:`, err.message);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => serverSocket.destroy());
}

// ── Start proxy server ──────────────────────────────────────────────────────

function startProxy() {
  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);

  server.listen(PROXY_PORT, () => {
    console.log(`[gate] Proxy listening on port ${PROXY_PORT}`);
    console.log(`[gate] Set HTTP_PROXY=http://localhost:${PROXY_PORT} to route agents through Gate`);
    if (!PROXY_API_KEY) {
      console.warn('[gate] WARNING: PROXY_API_KEY not set — proxy will fail closed on all requests');
    }
  });

  server.on('error', (err) => {
    console.error('[gate] Proxy server error:', err.message);
  });

  return server;
}

module.exports = { startProxy };
