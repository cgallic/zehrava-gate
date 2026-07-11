/**
 * Integration tests for A2H-style protocol hardening:
 *   - GET /.well-known/gate capability discovery (issue #2)
 *   - Approval lifecycle states + cancel-approval (issue #3)
 *   - Replay protection: nonce, timestamp tolerance, single-use links (issue #5)
 *   - A2H-shaped approval evidence bundles, fail-closed execution binding (issue #1)
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR so it can run standalone: `node test/a2h-hardening.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39100 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-a2h-test-'));

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

function promoteToReviewer(agentId) {
  // No public API sets agent role — tests reach into the same sqlite file
  // the running server process uses (WAL mode tolerates this) to promote
  // a freshly-registered agent to reviewer, mirroring how an operator would
  // do this via an admin console in a real deployment.
  delete require.cache[require.resolve('../src/lib/db')];
  process.env.DATA_DIR = DATA_DIR;
  const db = require('../src/lib/db');
  db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(agentId);
}

async function req(method, path, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
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
    body: {
      destination: 'salesforce.import',
      policy: 'crm-low-risk',
      recordCount: 200,
      payload: 'leads.csv',
      ...overrides
    }
  });
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  A2H Hardening Tests');
    console.log('  ═════════════════════\n');

    // ── Issue #2: discovery ────────────────────────────────────────────
    console.log('Discovery endpoint...');
    {
      const { status, body } = await req('GET', '/.well-known/gate');
      assert(status === 200, 'GET /.well-known/gate returns 200');
      assert(Array.isArray(body.gate_supported), 'has gate_supported array');
      assert(body.replay_protection?.nonce_endpoint === '/v1/nonce', 'advertises nonce endpoint');
      assert(Array.isArray(body.policy_features) && body.policy_features.length > 0, 'derives policy_features from real policies');
      assert(JSON.stringify(body).indexOf('gate_sk_') === -1, 'no API key / secret leakage in discovery body');
    }

    const reviewer = await registerAgent('reviewer-1');
    promoteToReviewer(reviewer.agentId);
    const agent = await registerAgent('agent-1');

    // ── Issue #5 + #1: propose → single-use link → evidence → execute ──
    console.log('\nPropose + message_id + approval link...');
    let intentId, linkToken, messageId;
    {
      const { status, body } = await proposeIntent(agent.apiKey);
      assert(status === 200, 'propose succeeds');
      assert(body.status === 'pending_approval', 'requires approval (over threshold)');
      assert(body.messageId && body.messageId.startsWith('msg_'), 'issues a message_id');
      assert(body.approvalLinkToken && body.approvalLinkToken.startsWith('alk_'), 'issues a single-use approval link token');
      intentId = body.intentId; linkToken = body.approvalLinkToken; messageId = body.messageId;
    }

    console.log('\nGET intent redacts the raw link token...');
    {
      const { body } = await req('GET', `/v1/intents/${intentId}`, { apiKey: reviewer.apiKey });
      assert(body.approval_state === 'waiting_input', 'approval_state is waiting_input after propose');
      assert(body.message_id === messageId, 'exposes message_id');
      assert(body.approval_link_token === undefined, 'never echoes raw approval_link_token back');
      assert(body.has_approval_link === true, 'signals a link exists via boolean flag');
    }

    console.log('\nApprove via single-use link...');
    let evidenceFromApprove;
    {
      const { status, body } = await req('POST', `/v1/approval-links/${linkToken}/approve`);
      assert(status === 200, 'link approve succeeds');
      assert(body.approvalEvidence?.protocol === 'a2h.v1', 'returns a2h.v1 evidence bundle');
      assert(body.approvalEvidence?.decision === 'APPROVE', 'evidence decision is APPROVE');
      assert(body.approvalEvidence?.responds_to === messageId, 'evidence responds_to matches original message_id');
      assert(!!body.approvalEvidence?.approved_intent_hash, 'evidence carries canonical intent hash');
      evidenceFromApprove = body.approvalEvidence;
    }

    console.log('\nReplayed use of the same link is rejected...');
    {
      const { status, body } = await req('POST', `/v1/approval-links/${linkToken}/approve`);
      assert(status === 410, 'reusing a consumed approval link returns 410');
      assert(body.error === 'link_already_used', 'reuse error is link_already_used');
    }

    console.log('\nExecution order issuance verifies evidence binding...');
    {
      const { status, body } = await req('POST', `/v1/intents/${intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(status === 201, 'execute succeeds when evidence binds to current intent');
      assert(body.approval_evidence?.consumed_at, 'evidence is marked consumed after execution issuance');
    }

    // ── Tamper detection: mutate destination after approval, before execute ──
    console.log('\nTampered intent after approval is refused at execute time...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-tamper.csv' });
      const tid = p.intentId;
      const approveRes = await req('POST', `/v1/intents/${tid}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveRes.status === 200, 'dashboard approve succeeds');

      delete require.cache[require.resolve('../src/lib/db')];
      process.env.DATA_DIR = DATA_DIR;
      const db = require('../src/lib/db');
      db.prepare("UPDATE proposals SET destination = 'evil.destination' WHERE id = ?").run(tid);

      const { status, body } = await req('POST', `/v1/intents/${tid}/execute`, { apiKey: reviewer.apiKey });
      assert(status === 409, 'execute refuses a tampered intent');
      assert(body.error === 'approval_evidence_invalid', 'error is approval_evidence_invalid');
      assert(body.reason === 'approved_intent_hash_mismatch', 'reason identifies the hash mismatch');
    }

    // ── Issue #3: lifecycle states + cancel ─────────────────────────────
    console.log('\nCancel-approval lifecycle...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-cancel.csv' });
      const cid = p.intentId;

      const cancelRes = await req('POST', `/v1/intents/${cid}/cancel-approval`, { apiKey: reviewer.apiKey, body: { reason: 'no longer needed' } });
      assert(cancelRes.status === 200, 'cancel-approval succeeds while waiting_input');
      assert(cancelRes.body.approvalState === 'cancelled', 'approval_state becomes cancelled');

      const approveAfterCancel = await req('POST', `/v1/intents/${cid}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveAfterCancel.status === 409, 'cannot approve after cancellation');

      const cancelAgain = await req('POST', `/v1/intents/${cid}/cancel-approval`, { apiKey: reviewer.apiKey, body: {} });
      assert(cancelAgain.status === 409, 'cannot cancel an already-cancelled interaction');
    }

    console.log('\nAlready-answered approval cannot be answered twice...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-double.csv' });
      const did = p.intentId;
      const r1 = await req('POST', `/v1/intents/${did}/reject`, { apiKey: reviewer.apiKey, body: { reason: 'bad' } });
      assert(r1.status === 200, 'first reject succeeds');
      const r2 = await req('POST', `/v1/intents/${did}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(r2.status === 409, 'cannot approve a rejected (already-answered) intent');
    }

    console.log('\nApproved intent cannot later be rejected (reverse-direction double-answer)...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-approve-then-reject.csv' });
      const aid = p.intentId;
      const approveRes = await req('POST', `/v1/intents/${aid}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveRes.status === 200, 'approve succeeds');

      const rejectRes = await req('POST', `/v1/intents/${aid}/reject`, { apiKey: reviewer.apiKey, body: { reason: 'changed my mind' } });
      assert(rejectRes.status === 409, 'rejecting an already-approved intent is refused');
      assert(rejectRes.body.error === 'already_answered', 'error is already_answered');
      assert(rejectRes.body.decision === 'APPROVE', 'reports the original decision was APPROVE');

      const { body: check } = await req('GET', `/v1/intents/${aid}`, { apiKey: reviewer.apiKey });
      assert(check.status === 'approved', 'intent status is unchanged after the refused reject');
    }

    console.log('\nDashboard approval invalidates the still-unused approval link (no duplicate execution)...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-dual-channel.csv' });
      const did = p.intentId, dashboardLink = p.approvalLinkToken;
      const approveRes = await req('POST', `/v1/intents/${did}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveRes.status === 200, 'dashboard approve succeeds');

      const linkRes = await req('POST', `/v1/approval-links/${dashboardLink}/approve`);
      assert(linkRes.status === 409, 'the still-unused approval link cannot re-approve an already-answered intent');
      assert(linkRes.body.error === 'already_answered', 'link approve error is already_answered');
    }

    // ── Issue #5: nonce + timestamp tolerance ───────────────────────────
    console.log('\nNonce issuance and single use...');
    {
      const { body: nonceBody } = await req('GET', '/v1/nonce', { apiKey: reviewer.apiKey });
      assert(nonceBody.nonce && nonceBody.nonce.startsWith('non_'), 'issues a nonce');

      const { body: p1 } = await proposeIntent(agent.apiKey, { payload: 'leads-nonce-1.csv' });
      const approveWithNonce = await req('POST', `/v1/intents/${p1.intentId}/approve`, { apiKey: reviewer.apiKey, body: { nonce: nonceBody.nonce } });
      assert(approveWithNonce.status === 200, 'approve succeeds with a fresh nonce');

      const { body: p2 } = await proposeIntent(agent.apiKey, { payload: 'leads-nonce-2.csv' });
      const replay = await req('POST', `/v1/intents/${p2.intentId}/reject`, { apiKey: reviewer.apiKey, body: { nonce: nonceBody.nonce, reason: 'x' } });
      assert(replay.status === 409, 'reusing the same nonce on a different decision is rejected');
      assert(replay.body.reason === 'nonce_already_used', 'reason is nonce_already_used');
    }

    console.log('\nStale timestamp outside tolerance is rejected...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'leads-stale.csv' });
      const staleTs = Date.now() - 20 * 60 * 1000; // 20 minutes ago, default tolerance is 5 minutes
      const { status, body } = await req('POST', `/v1/intents/${p.intentId}/reject`, {
        apiKey: reviewer.apiKey,
        body: { decided_at: staleTs, reason: 'x' }
      });
      assert(status === 409, 'stale decided_at is rejected');
      assert(body.reason === 'timestamp_out_of_tolerance', 'reason is timestamp_out_of_tolerance');
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
