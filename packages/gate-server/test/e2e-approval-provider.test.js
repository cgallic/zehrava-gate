/**
 * End-to-end harness for the approval-provider control-plane boundary
 * (issue #16): providers can collect consent, but only Gate can approve
 * the intent and issue execution access after verifying evidence.
 *
 * This is deliberately a *narrative* test distinct from the more granular
 * unit-style suites (dispatch-provider.test.js, provider-callback.test.js,
 * webhook-delivery.test.js) — it walks the full loop end to end the way a
 * real integration would, using Gate's built-in `noop` provider as a
 * deterministic mock (approve/decline/expire/replay/wrong-provider/
 * missing-factors), and proves execution access is impossible before a
 * verified approval exists.
 *
 * Usage:
 *   node test/e2e-approval-provider.test.js
 *
 * A real-provider staging smoke test is opt-in only — see the bottom of
 * this file. It never runs by default and never contacts a real human
 * unless you explicitly set GATE_E2E_REAL_PROVIDER=true plus
 * KAICALLS_API_BASE_URL/KAICALLS_API_KEY.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39500 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-e2e-test-'));
const MOCK_SECRET = 'e2e-mock-provider-secret';
const DASHBOARD_SECRET = 'e2e-dashboard-provider-secret';

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

async function mockProviderCallback(provider, payload, { secret = MOCK_SECRET, deliveryId } = {}) {
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

async function proposeHighRisk(apiKey, overrides = {}) {
  return req('POST', '/v1/intents', {
    apiKey,
    body: {
      destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 500, // over require_approval_over: 100
      payload: 'leads.csv', approval_provider: 'noop', principal_id: 'usr_e2e_demo',
      ...overrides,
    }
  });
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '', GATE_PROVIDER_SECRET_NOOP: MOCK_SECRET, GATE_PROVIDER_SECRET_DASHBOARD: DASHBOARD_SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  E2E: Approval-Provider Control-Plane Harness (issue #16)');
    console.log('  ══════════════════════════════════════════════════════════\n');

    const agent = await registerAgent('agent-e2e');
    const reviewer = await registerAgent('reviewer-e2e');
    promoteToReviewer(reviewer.agentId);

    console.log('Step 1-6: propose → pending_approval → no execution access → verified callback → approved → execute → audit...');
    let intentId, executionId;
    {
      // 1. propose a high-risk intent with a configured approval provider
      const { status, body: p } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-happy-path.csv' });
      assert(status === 200, '1. propose succeeds');
      intentId = p.intentId;

      // 2. assert status is pending_approval
      assert(p.status === 'pending_approval', '2. status is pending_approval');
      assert(!!p.approvalInteractionId, '2. a provider approval interaction was created');
      await waitForState(reviewer.apiKey, intentId, 'waiting_input');

      // Control-plane boundary: the provider has "delivered" the request
      // (mock dispatch), but nothing — not even Gate itself — can produce
      // an execution token until a verified decision exists.
      const executeBeforeApproval = await req('POST', `/v1/intents/${intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(executeBeforeApproval.status === 409, 'NO EXECUTION TOKEN is obtainable before approval (409)');
      assert(executeBeforeApproval.body.status === 'pending_approval', 'execute refusal reports the true pending status');

      // 3-4. simulate a signed provider callback; assert status becomes approved
      const { status: cbStatus, body: cbBody } = await mockProviderCallback('noop', {
        intent_id: intentId,
        gate_approval_interaction_id: p.approvalInteractionId,
        responds_to: p.messageId,
        decision: 'APPROVE',
        decided_at: Date.now(),
        evidence: { factors: [], proof: { source: 'e2e-mock-provider' } },
      }, { deliveryId: 'e2e_del_happy_path' });
      assert(cbStatus === 200, '3-4. verified callback approves the intent');
      assert(cbBody.status === 'approved', '4. status transitions to approved');

      // 5. request execution token
      const exec = await req('POST', `/v1/intents/${intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status === 201, '5. execution token is now issuable');
      executionId = exec.body.executionId;
      assert(!!exec.body.execution_token, '5. execution token is present');

      // 6. assert audit includes the approval interaction and evidence bundle
      const { body: audit } = await req('GET', `/v1/audit/${intentId}`, { apiKey: reviewer.apiKey });
      assert(!!audit.approval_evidence, '6. audit includes an approval evidence bundle');
      assert(audit.approval_evidence.decision === 'APPROVE', '6. evidence decision is APPROVE');

      const { body: intent } = await req('GET', `/v1/intents/${intentId}`, { apiKey: reviewer.apiKey });
      assert(intent.approval_interactions.some(i => i.state === 'answered'), '6. intent record includes an answered approval interaction');
    }

    console.log('\nDeclined path: verified DECLINE callback blocks execution permanently...');
    {
      const { body: p } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-decline-path.csv' });
      await waitForState(reviewer.apiKey, p.intentId, 'waiting_input');

      const cb = await mockProviderCallback('noop', {
        intent_id: p.intentId, decision: 'DECLINE', decided_at: Date.now(),
        evidence: { factors: [] },
      }, { deliveryId: 'e2e_del_decline' });
      assert(cb.status === 200, 'declined callback is accepted');
      assert(cb.body.status === 'blocked', 'intent status is blocked');

      const exec = await req('POST', `/v1/intents/${p.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status === 409, 'execution remains impossible after a decline');
    }

    console.log('\nAdversarial paths all fail in the E2E loop, never granting execution access...');
    {
      // Replay: the same delivery twice
      const { body: p1 } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-replay.csv' });
      await waitForState(reviewer.apiKey, p1.intentId, 'waiting_input');
      const payload1 = { intent_id: p1.intentId, decision: 'APPROVE', decided_at: Date.now() };
      const first = await mockProviderCallback('noop', payload1, { deliveryId: 'e2e_del_replay' });
      assert(first.status === 200, 'replay setup: first callback succeeds');
      const replay = await mockProviderCallback('noop', payload1, { deliveryId: 'e2e_del_replay' });
      assert(replay.status === 409, 'REPLAY: identical delivery_id is rejected');

      // Mismatch: approved_intent_hash tampered
      const { body: p2 } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-mismatch.csv' });
      await waitForState(reviewer.apiKey, p2.intentId, 'waiting_input');
      const mismatch = await mockProviderCallback('noop', {
        intent_id: p2.intentId, decision: 'APPROVE', approved_intent_hash: 'sha256:forged',
      }, { deliveryId: 'e2e_del_mismatch' });
      assert(mismatch.status === 409, 'MISMATCH: forged approved_intent_hash is rejected');
      const execMismatch = await req('POST', `/v1/intents/${p2.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(execMismatch.status === 409, 'MISMATCH: execution stays blocked after a rejected callback');

      // Expire: TTL elapses before any callback arrives
      const { body: p3 } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-expire.csv', expiresIn: '1s' });
      await waitForState(reviewer.apiKey, p3.intentId, 'waiting_input');
      await new Promise(r => setTimeout(r, 1200));
      const expired = await mockProviderCallback('noop', { intent_id: p3.intentId, decision: 'APPROVE' }, { deliveryId: 'e2e_del_expire' });
      assert(expired.status === 410, 'EXPIRE: callback after TTL elapses is rejected');

      // Wrong provider: dispatched via noop, callback claims a different provider
      const { body: p4 } = await proposeHighRisk(agent.apiKey, { payload: 'e2e-wrongprovider.csv' });
      await waitForState(reviewer.apiKey, p4.intentId, 'waiting_input');
      const wrongProvider = await mockProviderCallback('kaicalls', { intent_id: p4.intentId, decision: 'APPROVE' }, { secret: 'wrong-provider-has-no-configured-secret', deliveryId: 'e2e_del_wrongprovider' });
      assert(wrongProvider.status === 401 || wrongProvider.status === 409, 'WRONG PROVIDER: rejected (no secret configured or provider mismatch)');

      // Insufficient factors — 'dashboard' is the only built-in provider that
      // declares manual.dashboard.v1, so this is the one that can legally
      // require it at propose time and then be shown lacking it at callback time.
      const { body: p5 } = await proposeHighRisk(agent.apiKey, {
        payload: 'e2e-insufficient.csv',
        assurance: { level: 'HIGH', required_factors: ['manual.dashboard.v1'] },
        approval_provider: 'dashboard',
      });
      assert(p5.status === 'pending_approval', 'insufficient-factors setup: propose with a satisfiable requirement succeeds');
      await waitForState(reviewer.apiKey, p5.intentId, 'waiting_input');
      const insufficient = await mockProviderCallback('dashboard', {
        intent_id: p5.intentId, decision: 'APPROVE', evidence: { factors: [] },
      }, { secret: DASHBOARD_SECRET, deliveryId: 'e2e_del_insufficient' });
      assert(insufficient.status === 409 && insufficient.body.error === 'insufficient_evidence_factors', 'INSUFFICIENT FACTORS: rejected');
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

// ── Optional real-provider staging smoke test (KaiCalls) ──────────────────
//
// Disabled by default. Only runs if you explicitly opt in — this must never
// place a real call or send a real SMS as a side effect of running the test
// suite. Run directly (not via `npm test`):
//
//   GATE_E2E_REAL_PROVIDER=true \
//   KAICALLS_API_BASE_URL=https://staging.kaicalls.example \
//   KAICALLS_API_KEY=sk_staging_... \
//   KAICALLS_STAGING_TO=+15550001234 \
//   KAICALLS_STAGING_FROM_AGENT_ID=agt_staging_... \
//     node test/e2e-approval-provider.test.js --real-provider
//
// This block is intentionally excluded from `npm test` / CI and from the
// default `node test/e2e-approval-provider.test.js` run above — it only
// executes when both GATE_E2E_REAL_PROVIDER=true is set AND the script is
// invoked with --real-provider, so a bare `npm test` run can never
// accidentally dial or text a real phone.
if (process.env.GATE_E2E_REAL_PROVIDER === 'true' && process.argv.includes('--real-provider')) {
  if (!process.env.KAICALLS_API_BASE_URL || !process.env.KAICALLS_API_KEY || !process.env.KAICALLS_STAGING_TO || !process.env.KAICALLS_STAGING_FROM_AGENT_ID) {
    console.error('GATE_E2E_REAL_PROVIDER=true requires KAICALLS_API_BASE_URL, KAICALLS_API_KEY, KAICALLS_STAGING_TO, and KAICALLS_STAGING_FROM_AGENT_ID');
    process.exit(1);
  }
  console.log('\n  [opt-in] Real-provider staging smoke test would dispatch a live KaiCalls');
  console.log('  notification here. Wire this block up to your KaiCalls staging account');
  console.log('  and policy before relying on it — left as a stub so this file never');
  console.log('  ships a default path that can contact a real human.\n');
}
