/**
 * Tests for typed action profiles (issue #10): the module in isolation,
 * plus integration coverage of policy-required profiles, payload
 * validation, and profile-aware evidence/tamper binding on propose.
 *
 * `node test/action-profiles.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

console.log('\n  Typed Action Profile Tests (issue #10)');
console.log('  ═══════════════════════════════════════════\n');

// ── Unit: profile registry ──────────────────────────────────────────────
console.log('Profile registry unit tests...');
{
  const { listProfiles, getProfile, validateProfilePayload, canonicalProfileFieldsHash, redactProfileFields, summarizeProfile } =
    require('../src/lib/action-profiles');

  assert(listProfiles().length >= 3, 'registry has at least three profiles');
  assert(listProfiles().includes('email.send.v1'), 'includes email.send.v1');
  assert(listProfiles().includes('payment.refund.v1'), 'includes payment.refund.v1');

  const missing = validateProfilePayload('email.send.v1', { to: 'a@b.com' });
  assert(!missing.valid, 'missing required field (subject) fails validation');
  assert(missing.errors[0].includes('subject'), 'error names the missing field');

  const ok = validateProfilePayload('email.send.v1', { to: 'a@b.com', subject: 'Hi' });
  assert(ok.valid, 'complete payload passes validation');

  const unknown = validateProfilePayload('not.a.real.profile', {});
  assert(!unknown.valid && unknown.errors[0].includes('Unknown profile'), 'unknown profile is rejected');

  const h1 = canonicalProfileFieldsHash('email.send.v1', { to: 'a@b.com', subject: 'Hi', extra: 'ignored' });
  const h2 = canonicalProfileFieldsHash('email.send.v1', { to: 'a@b.com', subject: 'Hi' });
  assert(h1 === h2, 'hash ignores fields outside the profile schema');
  const h3 = canonicalProfileFieldsHash('email.send.v1', { to: 'a@b.com', subject: 'Different' });
  assert(h1 !== h3, 'hash changes when a required field changes');

  const redacted = redactProfileFields('email.send.v1', { to: 'a@b.com', subject: 'Hi' });
  assert(redacted.to === '[redacted]' && redacted.subject === 'Hi', 'redacts declared redact fields only');

  assert(summarizeProfile('payment.refund.v1', { amount_usd: 50, reason: 'defective' }).includes('50'), 'summary is human-readable');
}

// ── Integration: policy-required profile, validation, tamper binding ────
async function integrationTests() {
  const ROOT = path.join(__dirname, '..');
  const PORT = 39200 + (process.pid % 500);
  const BASE = `http://localhost:${PORT}`;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-profile-test-'));

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

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    const agent = await registerAgent('agent-profiles');
    const reviewer = await registerAgent('reviewer-profiles');
    promoteToReviewer(reviewer.agentId);

    console.log('\nPolicy requiring a profile rejects propose without one...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'gmail.send', policy: 'email-send-typed-profile-demo', payload: 'body text' }
      });
      assert(status === 400, 'missing profile is rejected');
      assert(body.error === 'profile_required', 'error is profile_required');
    }

    console.log('\nWrong profile against a policy that requires a specific one is rejected...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'gmail.send', policy: 'email-send-typed-profile-demo', payload: 'body text', profile: 'payment.refund.v1', metadata: { amount_usd: 1, reason: 'x' } }
      });
      assert(status === 400, 'mismatched profile is rejected');
      assert(body.error === 'profile_mismatch', 'error is profile_mismatch');
    }

    console.log('\nIncomplete profile payload is rejected...');
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'gmail.send', policy: 'email-send-typed-profile-demo', payload: 'body text', profile: 'email.send.v1', metadata: { to: 'a@b.com' } }
      });
      assert(status === 400, 'incomplete profile payload is rejected');
      assert(body.error === 'invalid_profile_payload', 'error is invalid_profile_payload');
    }

    console.log('\nComplete profile payload succeeds and carries a profile-aware summary...');
    let intentId;
    {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'gmail.send', policy: 'email-send-typed-profile-demo', payload: 'body text', profile: 'email.send.v1', metadata: { to: 'connor@example.com', subject: 'Q3 update' } }
      });
      assert(status === 200, 'propose succeeds');
      assert(body.profile === 'email.send.v1', 'response echoes the profile id');
      assert(body.profileSummary.includes('Q3 update'), 'response includes a profile-aware summary');
      intentId = body.intentId;
    }

    console.log('\nApproval evidence binds to the profile — tampering with profile fields after approval is caught at execute time...');
    {
      const approveRes = await req('POST', `/v1/intents/${intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveRes.status === 200, 'approve succeeds');

      delete require.cache[require.resolve('../src/lib/db')];
      process.env.DATA_DIR = DATA_DIR;
      const db = require('../src/lib/db');
      db.prepare("UPDATE proposals SET profile_fields_hash = 'sha256:forged' WHERE id = ?").run(intentId);

      const execRes = await req('POST', `/v1/intents/${intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(execRes.status === 409, 'execute refuses an intent whose profile fields were tampered with post-approval');
      assert(execRes.body.error === 'approval_evidence_invalid', 'error is approval_evidence_invalid');
    }

    console.log('\nAn unrestricted policy still validates a caller-supplied profile, but does not require one...');
    {
      const noProfile = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 10, payload: 'leads.csv' }
      });
      assert(noProfile.status === 200 && noProfile.body.profile === null, 'propose without a profile still works on an unrestricted policy');

      const badProfile = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 10, payload: 'leads.csv', profile: 'crm.import.v1', metadata: { object_type: 'lead' } }
      });
      assert(badProfile.status === 400 && badProfile.body.error === 'invalid_profile_payload', 'a caller-supplied profile is still validated even when the policy does not require one');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

integrationTests().then(() => {
  if (failed > 0) process.exitCode = 1;
}).catch(e => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
