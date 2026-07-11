/**
 * Integration tests for provider-neutral approval dispatch on POST /v1/propose
 * (issue #13): approval_provider / principal_id / approval_channel / assurance
 * request fields, validation, and failure semantics.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/dispatch-provider.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39700 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dispatch-test-'));

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

async function registerAgent(name) {
  const { body } = await req('POST', '/v1/agents/register', { body: { name, riskTier: 'standard' } });
  return body;
}

async function proposeIntent(apiKey, overrides = {}) {
  return req('POST', '/v1/intents', {
    apiKey,
    body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads.csv', ...overrides }
  });
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  Provider Dispatch Tests (issue #13)');
    console.log('  ══════════════════════════════════════\n');

    const agent = await registerAgent('agent-dispatch');

    console.log('Unknown approval_provider is rejected...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, { approval_provider: 'not-a-real-provider' });
      assert(status === 400, 'unknown provider returns 400');
      assert(body.error === 'invalid_provider', 'error is invalid_provider');
    }

    console.log('\nEmail/phone-shaped principal_id is rejected...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, { principal_id: 'connor@example.com' });
      assert(status === 400, 'email-shaped principal_id returns 400');
      assert(body.error === 'invalid_principal', 'error is invalid_principal');
    }

    console.log('\napproval_channel without address is rejected...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, { approval_channel: { type: 'sms' } });
      assert(status === 400, 'channel without address returns 400');
      assert(body.error === 'invalid_channel', 'error is invalid_channel');
    }

    console.log('\nRequesting a factor the resolved provider cannot satisfy is rejected...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, {
        approval_provider: 'dashboard',
        assurance: { level: 'CRITICAL', required_factors: ['passkey.webauthn.v1'] }
      });
      assert(status === 400, 'unsupported factor returns 400');
      assert(body.error === 'unsupported_factor', 'error is unsupported_factor');
      assert(body.provider === 'dashboard', 'names the resolved provider');
    }

    console.log('\nValid principal/channel/assurance dispatch succeeds and is stored on the ledger...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, {
        payload: 'leads-valid-dispatch.csv',
        approval_provider: 'dashboard',
        principal_id: 'usr_connor',
        approval_channel: { type: 'dashboard_link', address: 'internal' },
        assurance: { level: 'MEDIUM', required_factors: ['manual.dashboard.v1'] }
      });
      assert(status === 200, 'propose succeeds');
      assert(body.approvalProvider === 'dashboard', 'response echoes resolved provider');
      assert(!!body.approvalInteractionId && body.approvalInteractionId.startsWith('gai_'), 'response includes approvalInteractionId');

      const reviewer = await registerAgent('reviewer-dispatch');
      // No public API sets agent role — same pattern as a2h-hardening.test.js
      delete require.cache[require.resolve('../src/lib/db')];
      process.env.DATA_DIR = DATA_DIR;
      const db = require('../src/lib/db');
      db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

      const { body: intent } = await req('GET', `/v1/intents/${body.intentId}`, { apiKey: reviewer.apiKey });
      const interaction = intent.approval_interactions[0];
      assert(interaction.principalId === 'usr_connor', 'ledger stores principal_id');
      assert(interaction.channelType === 'dashboard_link', 'ledger stores requested channel type');
      assert(interaction.assuranceLevel === 'MEDIUM', 'ledger stores assurance level');
      assert(JSON.stringify(interaction.requiredFactors) === JSON.stringify(['manual.dashboard.v1']), 'ledger stores required factors');
    }

    console.log('\nMissing provider config still fails closed to \'failed\' state (kaicalls, no config)...');
    {
      const { status, body } = await proposeIntent(agent.apiKey, {
        payload: 'leads-kaicalls-no-config.csv',
        approval_provider: 'kaicalls'
      });
      assert(status === 200, 'propose itself succeeds (dispatch is async)');

      await new Promise(r => setTimeout(r, 300));
      const reviewer = await registerAgent('reviewer-dispatch-2');
      delete require.cache[require.resolve('../src/lib/db')];
      process.env.DATA_DIR = DATA_DIR;
      const db = require('../src/lib/db');
      db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

      const { body: intent } = await req('GET', `/v1/intents/${body.intentId}`, { apiKey: reviewer.apiKey });
      assert(intent.approval_state === 'failed', 'approval_state becomes failed — dispatch failure never silently approves');
      assert(intent.status !== 'approved', 'intent status is never approved on dispatch failure');
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
