/**
 * Integration tests for signed provider approval callbacks (issue #14):
 *   POST /v1/approval-callbacks/:provider
 *
 * Boots its own gate-server child process with provider signing secrets
 * configured, against an isolated, throwaway DATA_DIR:
 *   `node test/provider-callback.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39800 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-callback-test-'));
const NOOP_SECRET = 'test-noop-secret';
const KAICALLS_SECRET = 'test-kaicalls-secret';

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Server did not become healthy in time');
}

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function callbackReq(provider, payload, { secret, timestamp, deliveryId, badSignature = false } = {}) {
  const rawBody = JSON.stringify(payload);
  const t = timestamp !== undefined ? timestamp : Date.now();
  const v1 = badSignature ? 'deadbeef'.repeat(8) : sign(secret, t, rawBody);
  const headers = { 'Content-Type': 'application/json', 'X-Gate-Provider-Signature': `t=${t},v1=${v1}` };
  if (deliveryId) headers['X-Gate-Provider-Delivery-ID'] = deliveryId;
  const res = await fetch(`${BASE}/v1/approval-callbacks/${provider}`, { method: 'POST', headers, body: rawBody });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
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

async function proposeNoop(apiKey, overrides = {}) {
  return req('POST', '/v1/intents', {
    apiKey,
    body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads.csv', approval_provider: 'noop', ...overrides }
  });
}

async function getIntent(apiKey, id) {
  return req('GET', `/v1/intents/${id}`, { apiKey });
}

async function waitForState(apiKey, id, state, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await getIntent(apiKey, id);
    if (body.approval_state === state) return body;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for approval_state=${state}`);
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '',
      GATE_PROVIDER_SECRET_NOOP: NOOP_SECRET,
      GATE_PROVIDER_SECRET_KAICALLS: KAICALLS_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  Signed Provider Callback Tests (issue #14)');
    console.log('  ═══════════════════════════════════════════\n');

    const agent = await registerAgent('agent-callback');
    const reviewer = await registerAgent('reviewer-callback');
    promoteToReviewer(reviewer.agentId);

    console.log('Valid signed APPROVE callback approves the matching pending intent...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-approve.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');

      const { status, body } = await callbackReq('noop', {
        intent_id: p.intentId,
        gate_approval_interaction_id: p.approvalInteractionId,
        responds_to: p.messageId,
        decision: 'APPROVE',
        decided_at: Date.now(),
        evidence: { factors: [], proof: { note: 'mock provider decision' } },
      }, { secret: NOOP_SECRET, deliveryId: 'del_approve_1' });

      assert(status === 200, 'callback approve succeeds');
      assert(body.status === 'approved', 'intent status becomes approved');
      assert(body.approvalEvidence?.decision === 'APPROVE', 'evidence decision is APPROVE');

      const { body: intent } = await getIntent(reviewer.apiKey, p.intentId);
      assert(intent.status === 'approved', 'GET intent reflects approved status');
    }

    console.log('\nValid signed DECLINE callback declines — no execution access...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-decline.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');

      const { status, body } = await callbackReq('noop', {
        intent_id: p.intentId,
        decision: 'DECLINE',
        decided_at: Date.now(),
        evidence: { factors: [] },
      }, { secret: NOOP_SECRET, deliveryId: 'del_decline_1' });

      assert(status === 200, 'callback decline succeeds');
      assert(body.status === 'blocked', 'intent status becomes blocked');

      const exec = await req('POST', `/v1/intents/${p.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status === 409, 'execution is refused after a declined callback');
    }

    console.log('\nInvalid HMAC signature is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-badsig.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('noop', { intent_id: p.intentId, decision: 'APPROVE' }, { secret: NOOP_SECRET, badSignature: true, deliveryId: 'del_badsig' });
      assert(status === 401, 'bad signature returns 401');
      assert(body.error === 'invalid_signature', 'error is invalid_signature');
    }

    console.log('\nUnconfigured provider secret is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-nosecret.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('dashboard', { intent_id: p.intentId, decision: 'APPROVE' }, { secret: 'irrelevant-wrong-secret', deliveryId: 'del_nosecret' });
      assert(status === 401, 'unconfigured provider secret returns 401');
      assert(body.error === 'invalid_signature', 'error is invalid_signature');
      assert(body.reason === 'provider_secret_not_configured', 'reason explains no secret is configured for that provider');
    }

    console.log('\nStale timestamp outside tolerance is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-stale.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('noop', {
        intent_id: p.intentId, decision: 'APPROVE', decided_at: Date.now() - 20 * 60 * 1000,
      }, { secret: NOOP_SECRET, deliveryId: 'del_stale' });
      assert(status === 409, 'stale decided_at is rejected');
      assert(body.reason === 'timestamp_out_of_tolerance', 'reason is timestamp_out_of_tolerance');
    }

    console.log('\nDuplicate delivery_id is rejected on the second attempt...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-dupe.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const payload = { intent_id: p.intentId, decision: 'APPROVE', decided_at: Date.now() };
      const first = await callbackReq('noop', payload, { secret: NOOP_SECRET, deliveryId: 'del_dupe_1' });
      assert(first.status === 200, 'first delivery succeeds');
      const second = await callbackReq('noop', payload, { secret: NOOP_SECRET, deliveryId: 'del_dupe_1' });
      assert(second.status === 409, 'replayed delivery_id is rejected');
      assert(second.body.error === 'duplicate_delivery', 'error is duplicate_delivery');
    }

    console.log('\nWrong provider in the URL is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-wrongprovider.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('dashboard', { intent_id: p.intentId, decision: 'APPROVE' }, { secret: 'anything', deliveryId: 'del_wrongprovider' });
      // dashboard has no configured secret, so this actually fails on
      // signature first — prove the provider-mismatch guard separately below
      // using a provider that also has a secret configured.
      assert(status === 401, 'dashboard has no configured secret and fails signature check first');
    }
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-wrongprovider2.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      // Dispatched via noop, but callback hits the kaicalls URL with a
      // validly-signed kaicalls payload — signature passes, provider mismatch must still block it.
      const { status, body } = await callbackReq('kaicalls', { intent_id: p.intentId, decision: 'APPROVE' }, { secret: KAICALLS_SECRET, deliveryId: 'del_wrongprovider2' });
      assert(status === 409, 'mismatched provider is rejected even with a valid signature');
      assert(body.error === 'provider_mismatch', 'error is provider_mismatch');
    }

    console.log('\nMismatched responds_to is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-badresponds.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('noop', {
        intent_id: p.intentId, decision: 'APPROVE', responds_to: 'msg_totally_wrong',
      }, { secret: NOOP_SECRET, deliveryId: 'del_badresponds' });
      assert(status === 409, 'mismatched responds_to is rejected');
      assert(body.error === 'responds_to_mismatch', 'error is responds_to_mismatch');
    }

    console.log('\nMismatched approved_intent_hash is rejected...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-badhash.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const { status, body } = await callbackReq('noop', {
        intent_id: p.intentId, decision: 'APPROVE', approved_intent_hash: 'sha256:not-the-real-hash',
      }, { secret: NOOP_SECRET, deliveryId: 'del_badhash' });
      assert(status === 409, 'mismatched hash is rejected');
      assert(body.error === 'approved_intent_hash_mismatch', 'error is approved_intent_hash_mismatch');
    }

    console.log('\nCallback for an already-answered interaction is rejected (no double-answer)...');
    {
      const { body: p } = await proposeNoop(agent.apiKey, { payload: 'cb-doubleanswer.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');
      const payload = { intent_id: p.intentId, decision: 'APPROVE', decided_at: Date.now() };
      const first = await callbackReq('noop', payload, { secret: NOOP_SECRET, deliveryId: 'del_da_1' });
      assert(first.status === 200, 'first callback approves');
      const second = await callbackReq('noop', { ...payload, decided_at: Date.now() }, { secret: NOOP_SECRET, deliveryId: 'del_da_2' });
      assert(second.status === 409, 'second callback on an already-answered interaction is rejected');
    }

    console.log('\nInsufficient evidence factors are rejected (kaicalls, sms.otp.v1 required)...');
    {
      const { body: p } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: {
          destination: 'stripe.refund', policy: 'finance-high-risk-kaicalls-demo',
          payload: 'refund.json', estimated_value_usd: 500,
          assurance: { level: 'HIGH', required_factors: ['sms.otp.v1'] },
        }
      });
      assert(p.status === 'pending_approval', 'high-risk refund requires approval');
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');

      const { status, body } = await callbackReq('kaicalls', {
        intent_id: p.intentId, decision: 'APPROVE', decided_at: Date.now(),
        evidence: { factors: ['voice.spoken.v1'] }, // present, but not the required sms.otp.v1
      }, { secret: KAICALLS_SECRET, deliveryId: 'del_insufficient' });

      assert(status === 409, 'insufficient evidence factors returns 409');
      assert(body.error === 'insufficient_evidence_factors', 'error is insufficient_evidence_factors');
      assert(JSON.stringify(body.missing) === JSON.stringify(['sms.otp.v1']), 'names the missing factor');

      // A follow-up callback WITH the required factor should still succeed —
      // proves this was a real gate, not a permanently-broken interaction.
      const retry = await callbackReq('kaicalls', {
        intent_id: p.intentId, decision: 'APPROVE', decided_at: Date.now(),
        evidence: { factors: ['sms.otp.v1'] },
      }, { secret: KAICALLS_SECRET, deliveryId: 'del_insufficient_retry' });
      assert(retry.status === 200, 'retry with the required factor succeeds');
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
