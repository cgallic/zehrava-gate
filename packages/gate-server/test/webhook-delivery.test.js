/**
 * Integration tests for signed, retrying outbound webhook delivery (issue #6):
 *   - X-Gate-Signature timestamped HMAC + X-Gate-Delivery-ID
 *   - bounded exponential retry on failure, eventual 'failed' status
 *   - audit trail records each attempt and the final outcome
 *
 * Boots gate-server with a fast retry schedule and a local HTTP receiver
 * it fully controls, against an isolated, throwaway DATA_DIR:
 *   `node test/webhook-delivery.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39900 + (process.pid % 500);
const RECEIVER_PORT = 39600 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-webhook-test-'));
const WEBHOOK_SECRET = 'whsec_test_shared_secret';

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Server did not become healthy in time');
}

async function req(method, p, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function registerAgent(name) {
  const { body } = await req('POST', '/v1/agents/register', { body: { name, riskTier: 'standard' } });
  return body;
}

function promoteToReviewer(agentId) {
  delete require.cache[require.resolve('../src/lib/db')];
  process.env.DATA_DIR = DATA_DIR;
  const db = require('../src/lib/db');
  db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(agentId);
}

function verifySignature(secret, sigHeader, rawBody) {
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return expected === parts.v1;
}

// A receiver we fully control: `mode.behavior(attemptNumber)` decides the
// HTTP status to return for the Nth request received. Records every hit.
function startReceiver(behavior) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const attempt = hits.length + 1;
      hits.push({
        deliveryId: req.headers['x-gate-delivery-id'],
        signature: req.headers['x-gate-signature'],
        legacySecret: req.headers['x-gate-secret'],
        rawBody: raw,
        body: JSON.parse(raw || '{}'),
      });
      const status = behavior(attempt);
      res.writeHead(status);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(RECEIVER_PORT, () => resolve({ server, hits })));
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '',
      GATE_WEBHOOK_RETRY_DELAYS_MS: '0,50,50,50,50',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  Signed Webhook Delivery Tests (issue #6)');
    console.log('  ═══════════════════════════════════════════\n');

    const agent = await registerAgent('agent-webhook');
    const reviewer = await registerAgent('reviewer-webhook');
    promoteToReviewer(reviewer.agentId);

    console.log('First-attempt success is signed, carries a delivery ID, and audited...');
    {
      const { server: rx, hits } = await startReceiver(() => 200);
      try {
        const { body: p } = await req('POST', '/v1/intents', { apiKey: agent.apiKey, body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'whk-success.csv' } });
        await req('POST', '/v1/webhooks/register', { apiKey: agent.apiKey, body: { intentId: p.intentId, url: `http://localhost:${RECEIVER_PORT}`, secret: WEBHOOK_SECRET } });
        await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });

        await new Promise(r => setTimeout(r, 300));
        assert(hits.length === 1, 'exactly one delivery attempt on first-try success');
        const hit = hits[0];
        assert(!!hit.deliveryId && hit.deliveryId.startsWith('del_'), 'carries a delivery ID');
        assert(!!hit.signature, 'carries a signature header');
        assert(verifySignature(WEBHOOK_SECRET, hit.signature, hit.rawBody), 'signature verifies against the shared secret');
        assert(hit.legacySecret === WEBHOOK_SECRET, 'legacy X-Gate-Secret header is still sent for backward compat');
        assert(hit.body.event === 'approved', 'payload event is approved');

        const { body: audit } = await req('GET', `/v1/audit/${p.intentId}`, { apiKey: reviewer.apiKey });
        assert(audit.events.some(e => e.event_type === 'webhook_delivered'), 'audit trail records webhook_delivered');
      } finally {
        rx.close();
      }
    }

    console.log('\nTampered payload fails signature verification...');
    {
      const { server: rx, hits } = await startReceiver(() => 200);
      try {
        const { body: p } = await req('POST', '/v1/intents', { apiKey: agent.apiKey, body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'whk-tamper.csv' } });
        await req('POST', '/v1/webhooks/register', { apiKey: agent.apiKey, body: { intentId: p.intentId, url: `http://localhost:${RECEIVER_PORT}`, secret: WEBHOOK_SECRET } });
        await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
        await new Promise(r => setTimeout(r, 300));

        const hit = hits[0];
        const tamperedBody = hit.rawBody.replace('"approved"', '"blocked"');
        assert(!verifySignature(WEBHOOK_SECRET, hit.signature, tamperedBody), 'signature fails to verify once the body is tampered with');
      } finally {
        rx.close();
      }
    }

    console.log('\nFailures retry on a bounded schedule, then eventually succeed...');
    {
      const { server: rx, hits } = await startReceiver((attempt) => (attempt < 3 ? 500 : 200));
      try {
        const { body: p } = await req('POST', '/v1/intents', { apiKey: agent.apiKey, body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'whk-retry-success.csv' } });
        await req('POST', '/v1/webhooks/register', { apiKey: agent.apiKey, body: { intentId: p.intentId, url: `http://localhost:${RECEIVER_PORT}`, secret: WEBHOOK_SECRET } });
        await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });

        await new Promise(r => setTimeout(r, 1000));
        assert(hits.length === 3, 'retries until the 3rd attempt succeeds');
        assert(hits.every(h => h.deliveryId === hits[0].deliveryId), 'every retry carries the same delivery ID');
        assert(hits[0].body.attempt === 1 && hits[2].body.attempt === 3, 'payload attempt number increments per retry');

        const { body: audit } = await req('GET', `/v1/audit/${p.intentId}`, { apiKey: reviewer.apiKey });
        const attemptFailures = audit.events.filter(e => e.event_type === 'webhook_attempt_failed');
        assert(attemptFailures.length === 2, 'audit trail records the two failed attempts');
        assert(audit.events.some(e => e.event_type === 'webhook_delivered'), 'audit trail records the eventual success');
      } finally {
        rx.close();
      }
    }

    console.log('\nRetries exhaust to a permanent failed status...');
    {
      const { server: rx, hits } = await startReceiver(() => 500);
      try {
        const { body: p } = await req('POST', '/v1/intents', { apiKey: agent.apiKey, body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'whk-exhaust.csv' } });
        await req('POST', '/v1/webhooks/register', { apiKey: agent.apiKey, body: { intentId: p.intentId, url: `http://localhost:${RECEIVER_PORT}`, secret: WEBHOOK_SECRET } });
        await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });

        await new Promise(r => setTimeout(r, 1200));
        assert(hits.length === 5, 'exhausts all 5 configured attempts');

        const { body: audit } = await req('GET', `/v1/audit/${p.intentId}`, { apiKey: reviewer.apiKey });
        assert(audit.events.some(e => e.event_type === 'webhook_failed'), 'audit trail records the terminal webhook_failed event');
        assert(!audit.events.some(e => e.event_type === 'webhook_delivered'), 'never records a false webhook_delivered');
      } finally {
        rx.close();
      }
    }

    console.log('\nUnreachable URL fails cleanly without crashing the server...');
    {
      const { body: p } = await req('POST', '/v1/intents', { apiKey: agent.apiKey, body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'whk-unreachable.csv' } });
      await req('POST', '/v1/webhooks/register', { apiKey: agent.apiKey, body: { intentId: p.intentId, url: `http://localhost:1`, secret: WEBHOOK_SECRET } });
      await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      await new Promise(r => setTimeout(r, 1200));

      const health = await fetch(`${BASE}/health`);
      assert(health.ok, 'server survives repeated connection failures to an unreachable webhook URL');

      const { body: audit } = await req('GET', `/v1/audit/${p.intentId}`, { apiKey: reviewer.apiKey });
      assert(audit.events.some(e => e.event_type === 'webhook_failed'), 'unreachable URL eventually records webhook_failed');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
