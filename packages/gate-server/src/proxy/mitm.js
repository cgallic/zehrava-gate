'use strict';

/**
 * Gate V3 — TLS Intercept (HTTPS CONNECT MITM)
 *
 * When a client sends CONNECT hostname:443, instead of creating a blind TCP tunnel,
 * Gate:
 *   1. Responds 200 — client believes the tunnel is open
 *   2. Presents a CA-signed cert for the target hostname
 *   3. Decrypts the real HTTPS request
 *   4. Evaluates policy on the decrypted content
 *   5. Approved  → Gate opens TLS to real destination, forwards request
 *   6. Blocked   → 403 response through TLS
 *   7. Pending   → 202 + X-Gate-Intent-Id through TLS (agent retries with header)
 *
 * Phase 1 (current): retry model — agent gets 202, polls/retries
 * Phase 2.5 (future): hold queue — Gate replays on approval, agent sees no interruption
 */

const tls    = require('tls');
const https  = require('https');
const { getCertForHost } = require('./ca');
const { lookup, extractRecordCount } = require('./registry');

const GATE_PORT = parseInt(process.env.PORT || '3001');

// ── Parse raw HTTP request ────────────────────────────────────────────────────

function parseHttpRequest(buf) {
  const str = buf.toString('utf8');
  const headerEnd = str.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null; // incomplete headers

  const headerSection = str.slice(0, headerEnd);
  const body = str.slice(headerEnd + 4);
  const lines = headerSection.split('\r\n');

  const firstLine = lines[0].split(' ');
  const method = firstLine[0];
  const urlPath = firstLine[1] || '/';

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) {
      headers[lines[i].slice(0, idx).toLowerCase().trim()] = lines[i].slice(idx + 1).trim();
    }
  }

  return { method, urlPath, headers, body };
}

// ── Forward to real HTTPS destination ────────────────────────────────────────

function forwardToReal(hostname, port, parsed, tlsSocket) {
  const cleanHeaders = { ...parsed.headers };
  delete cleanHeaders['x-gate-intent-id'];
  cleanHeaders['host'] = hostname;

  const options = {
    hostname,
    port,
    path: parsed.urlPath,
    method: parsed.method,
    headers: cleanHeaders,
    rejectUnauthorized: true, // validate the real server's cert
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Reconstruct HTTP response to send through the TLS socket to client
    let head = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || 'OK'}\r\n`;
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) { v.forEach(val => head += `${k}: ${val}\r\n`); }
      else { head += `${k}: ${v}\r\n`; }
    }
    head += '\r\n';
    tlsSocket.write(head);
    proxyRes.pipe(tlsSocket, { end: false });
    proxyRes.on('end', () => tlsSocket.end());
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy:mitm] Forward error ${hostname}:`, err.message);
    sendTlsResponse(tlsSocket, 502, { error: 'upstream_error', message: err.message });
  });

  if (parsed.body) proxyReq.write(parsed.body);
  proxyReq.end();
}

// ── Send HTTP response through TLS socket ────────────────────────────────────

function sendTlsResponse(tlsSocket, statusCode, body, extraHeaders = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const statusText = { 200: 'OK', 202: 'Accepted', 403: 'Forbidden', 503: 'Service Unavailable', 502: 'Bad Gateway' }[statusCode] || 'Unknown';
  let response = `HTTP/1.1 ${statusCode} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(bodyStr)}\r\n`;
  for (const [k, v] of Object.entries(extraHeaders)) response += `${k}: ${v}\r\n`;
  response += '\r\n' + bodyStr;
  tlsSocket.write(response);
  // Don't destroy — keep alive for potential retries
}

// ── Internal Gate API call (reused from engine.js) ────────────────────────────

function gateApiCall(method, urlPath, body) {
  const http = require('http');
  const PROXY_API_KEY = process.env.PROXY_API_KEY;
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

// ── Main MITM handler ────────────────────────────────────────────────────────

function handleConnectMitm(req, clientSocket, head) {
  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr) || 443;

  // Get or generate cert for this hostname (~1-2s first time, instant from cache)
  let certData;
  try {
    certData = getCertForHost(hostname);
  } catch (e) {
    console.error('[proxy:mitm] Cert generation failed:', e.message);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  // Tell client the TCP tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Upgrade client connection to TLS in server mode using spoofed cert
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    cert: certData.cert,
    key:  certData.key,
    rejectUnauthorized: false,
  });

  let buffer = head && head.length ? head : Buffer.alloc(0);

  tlsSocket.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Wait for complete HTTP headers
    const str = buffer.toString('utf8');
    if (!str.includes('\r\n\r\n')) return;

    const parsed = parseHttpRequest(buffer);
    if (!parsed) return;

    // Passthrough for localhost/internal
    const destConfig = lookup(hostname, parsed.urlPath);
    if (destConfig.passthrough) {
      forwardToReal(hostname, port, parsed, tlsSocket);
      return;
    }

    // ── Retry: agent resending with X-Gate-Intent-Id ──────────────────────
    const existingIntentId = parsed.headers['x-gate-intent-id'];
    if (existingIntentId) {
      let intentResp;
      try {
        intentResp = await gateApiCall('GET', `/v1/intents/${existingIntentId}`);
      } catch (e) {
        sendTlsResponse(tlsSocket, 503, { error: 'gate_unreachable' });
        return;
      }

      const status = intentResp.body.status;
      if (status === 'approved') {
        console.log(`[proxy:mitm] ${existingIntentId} approved — forwarding ${parsed.method} ${hostname}${parsed.urlPath}`);
        forwardToReal(hostname, port, parsed, tlsSocket);
      } else if (status === 'pending_approval') {
        sendTlsResponse(tlsSocket, 202,
          { status: 'pending_approval', intentId: existingIntentId, retryAfterSeconds: 30 },
          { 'X-Gate-Intent-Id': existingIntentId, 'Retry-After': '30' }
        );
      } else {
        sendTlsResponse(tlsSocket, 403,
          { status, intentId: existingIntentId, blockReason: intentResp.body.blockReason || `Intent ${status}` }
        );
      }
      return;
    }

    // ── Fresh request — submit to Gate ───────────────────────────────────
    let recordCount;
    if (destConfig.extract_records && parsed.body) {
      try { recordCount = extractRecordCount(JSON.parse(parsed.body), destConfig.extract_records); } catch {}
    }

    const intentBody = {
      payload: (parsed.body || `${parsed.method} ${parsed.urlPath}`).slice(0, 400),
      destination: destConfig.destination || `${hostname}.https`,
      policy: destConfig.policy || 'crm-low-risk',
      recordCount,
      metadata: {
        proxy: true,
        tls: true,
        method: parsed.method,
        host: hostname,
        path: parsed.urlPath,
        content_type: parsed.headers['content-type'] || null,
      },
    };
    if (destConfig.require_approval === 'always') intentBody.require_approval = 'always';

    let intentResp;
    try {
      intentResp = await gateApiCall('POST', '/v1/intents', intentBody);
    } catch (e) {
      console.error('[proxy:mitm] Gate API unreachable — failing closed:', e.message);
      sendTlsResponse(tlsSocket, 503, { error: 'gate_unreachable', message: 'Failing closed.' });
      return;
    }

    const intent   = intentResp.body;
    const intentId = intent.intentId || intent.proposalId;
    const status   = intent.status;

    console.log(`[proxy:mitm] ${parsed.method} https://${hostname}${parsed.urlPath} → ${intentId} (${status})`);

    if (status === 'approved') {
      forwardToReal(hostname, port, parsed, tlsSocket);
    } else if (status === 'blocked' || status === 'duplicate_blocked') {
      sendTlsResponse(tlsSocket, 403,
        { status, intentId, blockReason: intent.blockReason, destination: destConfig.destination }
      );
    } else if (status === 'pending_approval') {
      sendTlsResponse(tlsSocket, 202,
        { status: 'pending_approval', intentId, message: 'Queued for human approval.', dashboard: `http://localhost:${GATE_PORT}/dashboard`, retryAfterSeconds: 30 },
        { 'X-Gate-Intent-Id': intentId, 'Retry-After': '30' }
      );
    } else {
      sendTlsResponse(tlsSocket, 502, { error: 'unexpected_status', status, intentId });
    }
  });

  tlsSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      console.error(`[proxy:mitm] TLS error ${hostname}:`, err.message);
    }
  });

  clientSocket.on('error', () => tlsSocket.destroy());
}

module.exports = { handleConnectMitm };
