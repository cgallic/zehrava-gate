/**
 * Integration tests for the A2H/Ola bridge provider (issue #7): outbound
 * AUTHORIZE dispatch (stub mode), missing-config failure, discovery, and
 * the full loop through the shared signed-callback verifier (#14) — proving
 * this provider is a plug-in on top of the generic machinery, not a special
 * case.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/a2h-bridge-provider.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39300 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-a2h-bridge-test-'));
const A2H_SECRET = 'test-a2h-bridge-secret';

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

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function callbackReq(provider, payload, { secret, deliveryId }) {
  const rawBody = JSON.stringify(payload);
  const t = Date.now();
  const headers = { 'Content-Type': 'application/json', 'X-Gate-Provider-Signature': `t=${t},v1=${sign(secret, t, rawBody)}` };
  if (deliveryId) headers['X-Gate-Provider-Delivery-ID'] = deliveryId;
  const res = await fetch(`${BASE}/v1/approval-callbacks/${provider}`, { method: 'POST', headers, body: rawBody });
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

async function waitForState(apiKey, id, state, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await req('GET', `/v1/intents/${id}`, { apiKey });
    if (body.approval_state === state) return body;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for approval_state=${state}`);
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '', GATE_PROVIDER_SECRET_A2H: A2H_SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  A2H/Ola Bridge Provider Tests (issue #7)');
    console.log('  ═══════════════════════════════════════════\n');

    const agent = await registerAgent('agent-a2h-bridge');
    const reviewer = await registerAgent('reviewer-a2h-bridge');
    promoteToReviewer(reviewer.agentId);

    console.log('Discovery advertises the a2h provider once a policy uses it...');
    {
      const { body } = await req('GET', '/.well-known/gate');
      assert(body.approval_providers.includes('a2h'), 'approval_providers includes a2h');
      assert(JSON.stringify(body.approval_provider_capabilities.a2h) === JSON.stringify(['a2h.signed_response.v1']), 'declares a2h.signed_response.v1 capability');
    }

    console.log('\nWell-configured a2h policy dispatches AUTHORIZE (stub) and reaches waiting_input...');
    let intentId, messageId, approvalInteractionId;
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy: 'a2h-bridge-demo', payload: 'refund.json', estimated_value_usd: 500 }
      });
      assert(status === 200, 'propose succeeds');
      assert(body.approvalProvider === 'a2h', 'resolved provider is a2h');
      intentId = body.intentId; messageId = body.messageId; approvalInteractionId = body.approvalInteractionId;
      const intent = await waitForState(reviewer.apiKey, intentId, 'waiting_input');
      assert(intent.approval_interactions[0].provider === 'a2h', 'ledger interaction records the a2h provider');
    }

    console.log('\nMissing gateway_url config fails dispatch, moves to failed...');
    {
      // crm-low-risk has no approval_channel.a2h block at all — requesting
      // the a2h provider explicitly should dispatch, find no gateway_url,
      // and fail closed rather than hang or silently approve.
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'refund-noconfig.csv', approval_provider: 'a2h' }
      });
      assert(status === 200, 'propose itself succeeds (dispatch is async)');
      const intent = await waitForState(reviewer.apiKey, body.intentId, 'failed');
      assert(intent.approval_state === 'failed', 'approval_state becomes failed — no gateway_url ever silently approves');
      assert(intent.status !== 'approved', 'intent status is never approved on missing config');
    }

    console.log('\nFull loop: dispatch via a2h, verify signed RESPONSE callback, approve, execute...');
    {
      const { status: cbStatus, body: cbBody } = await callbackReq('a2h', {
        intent_id: intentId,
        gate_approval_interaction_id: approvalInteractionId,
        responds_to: messageId,
        decision: 'APPROVE',
        decided_at: Date.now(),
        evidence: { factors: ['a2h.signed_response.v1'], proof: { gateway: 'ola-demo', response_id: 'resp_123' } },
      }, { secret: A2H_SECRET, deliveryId: 'del_a2h_bridge_1' });
      assert(cbStatus === 200, 'signed a2h callback approves the intent');
      assert(cbBody.approvalEvidence?.protocol === 'a2h.v1', 'evidence bundle is a2h.v1-shaped');

      const exec = await req('POST', `/v1/intents/${intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status === 201, 'execution token issuable after a verified a2h decision');
    }

    console.log('\nverifyResponse() shape check on the provider module itself...');
    {
      const a2hProvider = require('../src/lib/approval-providers/a2h');
      const valid = await a2hProvider.verifyResponse({ protocol: 'a2h.v1', decision: 'APPROVE', responds_to: 'msg_1' }, 'msg_1');
      assert(valid.valid === true, 'well-shaped a2h.v1 response passes the light protocol check');
      const badProtocol = await a2hProvider.verifyResponse({ protocol: 'other.v1', decision: 'APPROVE' }, 'msg_1');
      assert(badProtocol.valid === false && badProtocol.reason === 'not_a2h_protocol', 'wrong protocol is rejected');
      const badResponds = await a2hProvider.verifyResponse({ protocol: 'a2h.v1', decision: 'APPROVE', responds_to: 'msg_wrong' }, 'msg_1');
      assert(badResponds.valid === false && badResponds.reason === 'responds_to_mismatch', 'mismatched responds_to is rejected');
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
