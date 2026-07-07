/**
 * Integration tests for the KaiCalls approval provider — a notification-only
 * channel (SMS + optional voice call) that texts/calls the approver named in
 * policy with a link to Gate's own single-use approval page. Decision
 * capture always stays in Gate; KaiCalls never approves or rejects anything
 * itself. Runs entirely in stub mode (KAICALLS_API_BASE_URL/KAICALLS_API_KEY
 * intentionally unset) — no real SMS or call is ever sent.
 *
 * Boots its own gate-server child process against an isolated DATA_DIR and
 * POLICY_DIR so it can run standalone: `node test/kaicalls-provider.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39700 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-kaicalls-test-'));
const POLICY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-kaicalls-policies-'));

fs.writeFileSync(path.join(POLICY_DIR, 'kaicalls-ok.yaml'), `
id: kaicalls-ok
require_approval: always
destinations:
  - stripe.refund
expiry_minutes: 30
approval_channel:
  provider: kaicalls
  kaicalls:
    to: "+15550001234"
    from_agent_id: "agt_test"
`);

fs.writeFileSync(path.join(POLICY_DIR, 'kaicalls-missing-config.yaml'), `
id: kaicalls-missing-config
require_approval: always
destinations:
  - stripe.refund
expiry_minutes: 30
approval_channel:
  provider: kaicalls
  kaicalls:
    from_agent_id: "agt_test"
`);

fs.writeFileSync(path.join(POLICY_DIR, 'dashboard-default.yaml'), `
id: dashboard-default
require_approval: always
destinations:
  - stripe.refund
expiry_minutes: 30
`);

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

async function req(method, path, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function pollApprovalState(intentId, apiKey, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await req('GET', `/v1/intents/${intentId}`, { apiKey });
    if (body?.approval_state && body.approval_state !== 'sent') return body.approval_state;
    await new Promise(r => setTimeout(r, 100));
  }
  return 'sent'; // dispatch never resolved in time
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, POLICY_DIR, PORT: String(PORT), PROXY_API_KEY: '', KAICALLS_API_BASE_URL: '', KAICALLS_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  KaiCalls Approval Provider Tests');
    console.log('  ══════════════════════════════════\n');

    const { body: agent } = await req('POST', '/v1/agents/register', { body: { name: 'kaicalls-tester' } });

    console.log('Discovery advertises the kaicalls provider once a policy uses it...');
    {
      const { body } = await req('GET', '/.well-known/gate');
      assert(body.approval_providers?.includes('kaicalls'), 'approval_providers includes kaicalls');
      assert(body.policy_features?.includes('approval_channel_routing'), 'policy_features includes approval_channel_routing');
    }

    console.log('\nWell-configured kaicalls policy dispatches SMS + call (stub) and reaches waiting_input...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy: 'kaicalls-ok', payload: 'refund.json' }
      });
      assert(status === 200, 'propose succeeds');
      assert(body.approvalState === 'sent', 'approval_state is sent immediately (dispatch is async)');

      const finalState = await pollApprovalState(body.intentId, agent.apiKey);
      assert(finalState === 'waiting_input', 'approval_state reaches waiting_input once dispatch completes');
      assert(serverLog.includes('would send_sms'), 'stub SMS dispatch was logged');
      assert(serverLog.includes('would place_call'), 'stub voice call dispatch was logged');
      assert(serverLog.includes(body.approvalLinkToken), 'the dispatched message carries the single-use approval link token');
    }

    console.log('\nMissing required kaicalls config fails dispatch, moves to failed...');
    {
      const { body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy: 'kaicalls-missing-config', payload: 'refund2.json' }
      });
      const finalState = await pollApprovalState(body.intentId, agent.apiKey);
      assert(finalState === 'failed', 'approval_state becomes failed when required channel config is missing');
    }

    console.log('\nDefault (no approval_channel) policy is unaffected — stays synchronous dashboard flow...');
    {
      const { body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy: 'dashboard-default', payload: 'refund3.json' }
      });
      assert(body.approvalState === 'waiting_input', 'dashboard policy still transitions synchronously to waiting_input');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(POLICY_DIR, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
