#!/usr/bin/env node
/**
 * Minimal A2H v1.0 gateway — a local stand-in for Twilio Ola so the
 * Gate + Ola flow can run end to end without an Ola account.
 *
 * Implements the gateway side of the open A2H spec
 * (https://github.com/twilio-labs/Agent2Human, a2h_framework.md):
 *   GET  /.well-known/a2h          discovery (§1.4)
 *   GET  /.well-known/jwks.json    public key for RESPONSE signatures (§1.11.2)
 *   POST /v1/intent                AUTHORIZE intake, idempotent on message_id (§1.10.2)
 *   GET  /v1/status/:id            status polling (§1.7)
 *   POST /v1/cancel/:id            cancellation (§1.7)
 *   GET  /approve/:id              a tiny approval page standing in for the SMS/passkey step
 *   POST /approve/:id              the human's decision from that page
 *
 * When the human decides, the gateway builds a RESPONSE, signs it with a
 * detached ES256 JWS over the JCS-canonical message, and — if the AUTHORIZE
 * carried a callback — delivers it with X-A2H-Signature / X-A2H-Delivery-ID
 * (§1.12). No dependencies beyond Node 18+.
 *
 * Standalone:  node examples/ola-a2h/mock-gateway.js   (port 4100, API key a2h_demo_key)
 * Library:     const { createMockGateway } = require('./mock-gateway')
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ── JCS + detached JWS (same construction Gate verifies) ─────────────────

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signDetached(message, privateKey, kid) {
  const { signature, ...rest } = message;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid }));
  const payload = b64url(canonicalize(rest));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}..${b64url(sig)}`;
}

// ── Gateway ──────────────────────────────────────────────────────────────

function createMockGateway({
  port = 0,
  apiKey = 'a2h_demo_key',
  signResponses = true, // false → unsigned RESPONSEs, like the reference gateway
  webhooks = true,      // false → ignore callbacks, force the agent to poll
  log = () => {},
} = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = `mock-${crypto.randomBytes(4).toString('hex')}`;
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] };

  const interactions = new Map(); // interaction_id → record
  const byMessageId = new Map();  // message_id → interaction_id
  const requests = [];            // every inbound request, for assertions
  let baseUrl = null;

  function authorized(req) {
    const key = req.headers['x-a2h-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');
    return key === apiKey;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function refreshExpiry(rec) {
    if (rec.state === 'WAITING_INPUT' && Date.now() > rec.expiresAt) rec.state = 'EXPIRED';
    return rec;
  }

  function buildResponse(rec) {
    const message = {
      a2h_version: '1.0',
      type: 'RESPONSE',
      interaction_id: rec.id,
      message_id: crypto.randomUUID(),
      responds_to: rec.message.message_id,
      status: 'ANSWERED',
      decision: rec.decision,
      decided_at: rec.decidedAt,
      evidence: rec.evidence,
    };
    if (signResponses) message.signature = signDetached(message, privateKey, kid);
    return message;
  }

  function statusBody(rec) {
    refreshExpiry(rec);
    if (rec.state === 'ANSWERED') return { ...buildResponse(rec), state: 'ANSWERED' };
    return { interaction_id: rec.id, state: rec.state, principal_id: rec.message.principal_id || null };
  }

  // Signs and POSTs a body to the AUTHORIZE's callback (spec §1.12.3-4).
  async function deliverWebhook(rec, body, { deliveryId = `del_${crypto.randomUUID()}`, secret, timestampSec } = {}) {
    const callback = rec.message.callback;
    if (!callback?.url) return { delivered: false, reason: 'no_callback' };
    const raw = JSON.stringify(body);
    const t = timestampSec ?? Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret ?? callback.secret).update(`${t}.${raw}`).digest('hex');
    const res = await fetch(callback.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-A2H-Signature': `t=${t},v1=${v1}`, 'X-A2H-Delivery-ID': deliveryId },
      body: raw,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    log(`→ webhook ${body.type} ${body.decision || body.error?.code || ''} → ${res.status}`);
    return { delivered: true, status: res.status, body: json, deliveryId };
  }

  // The human's decision. Delivers the signed RESPONSE by webhook when the
  // AUTHORIZE asked for one (and webhooks are on); otherwise the agent polls.
  async function decide(interactionId, decision, { factor = 'passkey.webauthn.v1', proof, deliver = webhooks } = {}) {
    const rec = interactions.get(interactionId);
    if (!rec) throw new Error(`unknown interaction ${interactionId}`);
    refreshExpiry(rec);
    if (rec.state !== 'WAITING_INPUT') throw new Error(`interaction ${interactionId} is ${rec.state}`);
    rec.state = 'ANSWERED';
    rec.decision = String(decision).toUpperCase();
    rec.decidedAt = new Date().toISOString();
    rec.evidence = { factor, proof: proof || { verified_at: rec.decidedAt, note: 'mock gateway attestation' } };
    log(`✓ human ${rec.decision} ${interactionId} (${factor})`);
    const response = buildResponse(rec);
    const delivery = deliver ? await deliverWebhook(rec, response) : { delivered: false, reason: 'webhooks_disabled' };
    return { response, delivery };
  }

  function approvalPage(rec) {
    const render = rec.message.render || rec.message.channel?.render || {};
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(render.title || 'Approval request')}</title>
<body style="font-family:system-ui;background:#0a0a0c;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" style="background:#1c1c1f;border-radius:24px;padding:32px;max-width:420px">
<p style="font-family:monospace;color:#a1a1aa;margin:0 0 12px">A2H · AUTHORIZE · ${esc(rec.state)}</p>
<h1 style="margin:0 0 12px;font-size:24px">${esc(render.title || 'Approval request')}</h1>
<p style="color:#a1a1aa;line-height:1.6">${esc(render.body)}</p>
${rec.state === 'WAITING_INPUT' ? `<button name="decision" value="APPROVE" style="padding:12px 20px;border-radius:999px;border:0;background:#8b8dff;font-weight:700">Approve</button>
<button name="decision" value="DECLINE" style="padding:12px 20px;border-radius:999px;border:1px solid #555;background:none;color:#fafafa;font-weight:700">Decline</button>` : ''}
</form></body>`;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const raw = await readBody(req);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/a2h') {
        return send(res, 200, {
          a2h_supported: ['1.0'],
          auth: { methods: ['api_key'] },
          channels: ['sms', 'email', 'push'],
          factors: ['passkey.webauthn.v1', 'otp.sms.v1', 'push.v1'],
          max_ttl_sec: 3600,
          jwks_uri: `${baseUrl}/.well-known/jwks.json`,
          webhooks: { supported: webhooks, retry_attempts: 0, timeout_sec: 30 },
          replay_protection: { idempotency_window_sec: 3600, timestamp_tolerance_sec: 300 },
        });
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return send(res, 200, jwks);

      if (req.method === 'POST' && url.pathname === '/v1/intent') {
        if (!authorized(req)) return send(res, 401, { error: { code: 'ERR.UNAUTHORIZED', message: 'Invalid API key' } });
        if (!body || body.a2h_version !== '1.0' || !body.message_id || !body.type) {
          return send(res, 400, { error: { code: 'ERR.INVALID_REQUEST', message: 'a2h_version 1.0, type and message_id are required' } });
        }
        if (body.type !== 'AUTHORIZE') return send(res, 400, { error: { code: 'ERR.INVALID_REQUEST', message: `mock gateway only handles AUTHORIZE, got ${body.type}` } });
        if (!(body.render?.body || body.channel?.render?.body)) return send(res, 400, { error: { code: 'ERR.INVALID_REQUEST', message: 'render.body is required' } });

        const existing = byMessageId.get(body.message_id);
        if (existing) return send(res, 200, { interaction_id: existing, state: interactions.get(existing).state, duplicate: true });

        const id = crypto.randomUUID();
        const ttlSec = Math.max(30, Number(body.ttl_sec) || 300);
        interactions.set(id, { id, message: body, state: 'WAITING_INPUT', createdAt: Date.now(), expiresAt: Date.now() + ttlSec * 1000 });
        byMessageId.set(body.message_id, id);
        log(`← AUTHORIZE ${id}: "${body.render?.body || body.channel?.render?.body}"`);
        log(`  approve at ${baseUrl}/approve/${id}`);
        return send(res, 202, { interaction_id: id, state: 'WAITING_INPUT', approval_url: `${baseUrl}/approve/${id}` });
      }

      const statusMatch = url.pathname.match(/^\/v1\/status\/([^/]+)$/);
      if (req.method === 'GET' && statusMatch) {
        if (!authorized(req)) return send(res, 401, { error: { code: 'ERR.UNAUTHORIZED', message: 'Invalid API key' } });
        const rec = interactions.get(decodeURIComponent(statusMatch[1]));
        if (!rec) return send(res, 404, { error: { code: 'ERR.INVALID_REQUEST', message: 'Interaction not found' } });
        return send(res, 200, statusBody(rec));
      }

      const cancelMatch = url.pathname.match(/^\/v1\/cancel\/([^/]+)$/);
      if (req.method === 'POST' && cancelMatch) {
        if (!authorized(req)) return send(res, 401, { error: { code: 'ERR.UNAUTHORIZED', message: 'Invalid API key' } });
        const rec = interactions.get(decodeURIComponent(cancelMatch[1]));
        if (!rec) return send(res, 404, { error: { code: 'ERR.INVALID_REQUEST', message: 'Interaction not found' } });
        refreshExpiry(rec);
        if (rec.state !== 'WAITING_INPUT') return send(res, 409, { error: 'ERR.CONFLICT', message: `Interaction already ${rec.state}` });
        rec.state = 'CANCELLED';
        log(`✕ cancelled ${rec.id}`);
        return send(res, 200, { success: true, message: 'Interaction cancelled', state: 'CANCELLED' });
      }

      const approveMatch = url.pathname.match(/^\/approve\/([^/]+)$/);
      if (approveMatch) {
        const rec = interactions.get(decodeURIComponent(approveMatch[1]));
        if (!rec) return send(res, 404, '<p>Unknown approval request</p>');
        if (req.method === 'POST') {
          const decision = new URLSearchParams(raw).get('decision') || body?.decision;
          if (refreshExpiry(rec).state === 'WAITING_INPUT' && decision) await decide(rec.id, decision);
        }
        return send(res, 200, approvalPage(refreshExpiry(rec)));
      }

      return send(res, 404, { error: { code: 'ERR.INVALID_REQUEST', message: 'Not found' } });
    } catch (e) {
      return send(res, 500, { error: { code: 'ERR.INTERNAL', message: e.message } });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      // 127.0.0.1, not localhost: Node 18's fetch tries ::1 first and does
      // not fall back to IPv4, so a localhost URL misses this listener.
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: baseUrl,
        apiKey,
        jwks,
        privateKey,
        kid,
        interactions,
        requests,
        decide,
        deliverWebhook,
        buildResponse,
        signDetached: (message) => signDetached(message, privateKey, kid),
        interactionForMessage: (messageId) => interactions.get(byMessageId.get(messageId)) || null,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { createMockGateway, canonicalize };

if (require.main === module) {
  const port = Number(process.env.PORT || 4100);
  createMockGateway({ port, apiKey: process.env.A2H_API_KEY || 'a2h_demo_key', log: (m) => console.log(m) }).then((gw) => {
    console.log(`Mock A2H gateway on ${gw.url}  (API key: ${gw.apiKey})`);
    console.log(`Discovery: ${gw.url}/.well-known/a2h`);
  });
}
