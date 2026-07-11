/**
 * Integration tests for risk-tiered approval assurance policy (issue #15):
 * policy-declared required factors by risk level, applied automatically
 * from the intent's computed risk_level, enforced at callback time.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/risk-tiered-assurance.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39400 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-assurance-test-'));
const KAICALLS_SECRET = 'test-assurance-kaicalls-secret';

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
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '', GATE_PROVIDER_SECRET_KAICALLS: KAICALLS_SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  Risk-Tiered Approval Assurance Tests (issue #15)');
    console.log('  ═══════════════════════════════════════════════════\n');

    const agent = await registerAgent('agent-assurance');
    const reviewer = await registerAgent('reviewer-assurance');
    promoteToReviewer(reviewer.agentId);

    console.log('A critical-risk intent automatically inherits the policy\'s critical-tier factors...');
    let intentId;
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: {
          destination: 'stripe.refund', policy: 'finance-high-risk-assurance-demo',
          payload: 'refund-critical.json', estimated_value_usd: 50000,
          sensitivity_tags: ['financial'],
        }
      });
      assert(status === 200, 'propose succeeds');
      assert(body.riskLevel === 'critical', 'risk scoring computed critical tier');
      assert(body.assuranceLevel === 'CRITICAL', 'response reports CRITICAL assurance, derived from policy — no assurance field was sent');
      assert(JSON.stringify(body.requiredApprovalFactors) === JSON.stringify(['voice.ivr.v1', 'sms.otp.v1']), 'required factors match the policy\'s critical tier');
      intentId = body.intentId;
      await waitForState(reviewer.apiKey, intentId, 'waiting_input');
    }

    console.log('\nCallback missing one policy-required factor is rejected...');
    {
      const { status, body } = await callbackReq('kaicalls', {
        intent_id: intentId, decision: 'APPROVE', decided_at: Date.now(),
        evidence: { factors: ['voice.ivr.v1'] }, // missing sms.otp.v1
      }, { secret: KAICALLS_SECRET, deliveryId: 'del_assurance_partial' });
      assert(status === 409, 'partial evidence is rejected');
      assert(body.error === 'insufficient_evidence_factors', 'error is insufficient_evidence_factors');
      assert(JSON.stringify(body.missing) === JSON.stringify(['sms.otp.v1']), 'names exactly the missing factor');
    }

    console.log('\nCallback with all policy-required factors succeeds...');
    {
      const { status, body } = await callbackReq('kaicalls', {
        intent_id: intentId, decision: 'APPROVE', decided_at: Date.now(),
        evidence: { factors: ['voice.ivr.v1', 'sms.otp.v1'] },
      }, { secret: KAICALLS_SECRET, deliveryId: 'del_assurance_full' });
      assert(status === 200, 'full evidence approves the intent');
      assert(body.status === 'approved', 'intent status becomes approved');
    }

    console.log('\nA low-risk intent under the same policy requires no factors...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy: 'finance-high-risk-assurance-demo', payload: 'refund-low.json' }
      });
      // require_approval: always on this policy means it's still pending_approval,
      // but risk score without value/records/tags stays low.
      assert(body.riskLevel === 'low' || body.riskLevel === 'medium', 'risk without value/tags stays low-to-medium');
      if (body.riskLevel === 'low') {
        assert(JSON.stringify(body.requiredApprovalFactors) === JSON.stringify([]), 'low tier requires no factors under this policy');
      }
    }

    console.log('\nExplicit request-body assurance overrides the policy-derived tier...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: {
          destination: 'stripe.refund', policy: 'finance-high-risk-assurance-demo',
          payload: 'refund-override.json', estimated_value_usd: 50000, sensitivity_tags: ['financial'],
          assurance: { level: 'MEDIUM', required_factors: ['voice.ivr.v1'] },
        }
      });
      assert(status === 200, 'propose with explicit override succeeds');
      assert(body.assuranceLevel === 'MEDIUM', 'explicit assurance level wins over the policy-derived CRITICAL tier');
      assert(JSON.stringify(body.requiredApprovalFactors) === JSON.stringify(['voice.ivr.v1']), 'explicit required_factors win over the policy tier');
    }

    console.log('\nA policy-declared factor the provider cannot satisfy is rejected at propose time...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: {
          destination: 'stripe.refund', policy: 'finance-critical-unsatisfiable-demo',
          payload: 'refund-unsatisfiable.json', estimated_value_usd: 50000, sensitivity_tags: ['financial'],
        }
      });
      assert(status === 400, 'propose is rejected before any dispatch happens');
      assert(body.error === 'unsupported_factor', 'error is unsupported_factor');
      assert(body.provider === 'kaicalls', 'names the policy-resolved provider');
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
