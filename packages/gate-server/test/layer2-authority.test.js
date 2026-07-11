/**
 * Integration tests for the Layer 2 authority model (issue #8): standing
 * approvals, revocation, delegation, N-of-M approvals, and conditional
 * timeout defaults.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/layer2-authority.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39100 + 1000 + (process.pid % 400); // avoid clashing with a2h-hardening's range
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-layer2-test-'));

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
    console.log('\n  Layer 2 Authority Model Tests (issue #8)');
    console.log('  ═══════════════════════════════════════════\n');

    const agent = await registerAgent('agent-layer2');
    const reviewer = await registerAgent('reviewer-layer2');
    promoteToReviewer(reviewer.agentId);

    // ── Standing approvals ──────────────────────────────────────────────
    console.log('Standing approval auto-approves a matching intent under its cap...');
    let standingId;
    {
      const create = await req('POST', '/v1/standing-approvals', {
        apiKey: reviewer.apiKey,
        body: { destination: 'salesforce.import', principal_id: 'usr_standing_demo', max_amount_usd: 100, daily_limit_usd: 150 }
      });
      assert(create.status === 201, 'create standing approval succeeds');
      standingId = create.body.id;

      const propose = await proposeIntent(agent.apiKey, {
        payload: 'standing-under-cap.csv', principal_id: 'usr_standing_demo', estimated_value_usd: 50,
      });
      assert(propose.body.status === 'approved', 'intent under the cap is auto-approved by the standing approval');
      assert(propose.body.standingApprovalId === standingId, 'response cites the standing approval that applied');

      const { body: audit } = await req('GET', `/v1/audit/${propose.body.intentId}`, { apiKey: reviewer.apiKey });
      assert(audit.events.some(e => e.event_type === 'standing_approval_applied'), 'audit trail records standing_approval_applied');
    }

    console.log('\nStanding approval refuses an intent over its per-transaction cap...');
    {
      const propose = await proposeIntent(agent.apiKey, {
        payload: 'standing-over-cap.csv', principal_id: 'usr_standing_demo', estimated_value_usd: 500,
      });
      assert(propose.body.status === 'pending_approval', 'over-cap intent falls back to normal manual approval');
      assert(propose.body.standingApprovalId === null, 'no standing approval is cited');
    }

    console.log('\nStanding approval respects its daily cumulative limit...');
    {
      // Already spent $50 above; $80 more brings the running total to $130,
      // still under the $150 daily cap...
      const first = await proposeIntent(agent.apiKey, { payload: 'standing-daily-1.csv', principal_id: 'usr_standing_demo', estimated_value_usd: 80 });
      assert(first.body.status === 'approved', 'still under the daily cap: auto-approved');
      // ...but $130 + $80 = $210 would push it over the $150 cap.
      const second = await proposeIntent(agent.apiKey, { payload: 'standing-daily-2.csv', principal_id: 'usr_standing_demo', estimated_value_usd: 80 });
      assert(second.body.status === 'pending_approval', 'exceeding the daily cap falls back to manual approval');
    }

    console.log('\nRevoking a standing approval stops future auto-approval...');
    {
      const revoke = await req('POST', `/v1/standing-approvals/${standingId}/revoke`, { apiKey: reviewer.apiKey, body: { reason: 'no longer needed' } });
      assert(revoke.status === 200, 'revoke succeeds');

      const propose = await proposeIntent(agent.apiKey, { payload: 'standing-after-revoke.csv', principal_id: 'usr_standing_demo', estimated_value_usd: 10 });
      assert(propose.body.status === 'pending_approval', 'a revoked standing approval no longer auto-approves');

      const revokeAgain = await req('POST', `/v1/standing-approvals/${standingId}/revoke`, { apiKey: reviewer.apiKey, body: {} });
      assert(revokeAgain.status === 409, 'cannot revoke an already-revoked standing approval');
    }

    // ── Delegation ───────────────────────────────────────────────────────
    console.log('\nDelegated approval records both principal and delegate...');
    let delegationId;
    {
      const create = await req('POST', '/v1/delegations', {
        apiKey: reviewer.apiKey,
        body: { delegator_principal_id: 'usr_alice', delegate_agent_id: agent.agentId, destination: 'salesforce.import', max_amount_usd: 1000 }
      });
      assert(create.status === 201, 'create delegation succeeds');
      delegationId = create.body.id;

      // The delegate (a non-reviewer agent) still can't approve without a
      // reviewer role UNLESS acting through the delegation — Gate requires
      // a reviewer key for /approve regardless, so grant agent reviewer
      // role here to isolate the delegation-authorization check itself.
      delete require.cache[require.resolve('../src/lib/db')];
      process.env.DATA_DIR = DATA_DIR;
      const db = require('../src/lib/db');
      db.prepare("UPDATE agents SET role = 'reviewer' WHERE id = ?").run(agent.agentId);

      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'delegated-approve.csv', estimated_value_usd: 500 });
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, {
        apiKey: agent.apiKey, body: { on_behalf_of_principal: 'usr_alice' }
      });
      assert(approve.status === 200, 'delegate approves on behalf of the principal');
      assert(approve.body.approvalEvidence?.proof?.delegation?.principal_id === 'usr_alice', 'evidence records the delegating principal');
      assert(approve.body.approvalEvidence?.proof?.delegation?.delegate_agent_id === agent.agentId, 'evidence records the delegate agent');
    }

    console.log('\nApproval on behalf of a principal with no matching delegation is refused...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'delegated-no-match.csv' });
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, {
        apiKey: agent.apiKey, body: { on_behalf_of_principal: 'usr_someone_else' }
      });
      assert(approve.status === 403, 'no matching delegation is refused');
      assert(approve.body.error === 'delegation_not_found', 'error is delegation_not_found');
    }

    console.log('\nRevoking a delegation stops future delegated approvals...');
    {
      const revoke = await req('POST', `/v1/delegations/${delegationId}/revoke`, { apiKey: reviewer.apiKey, body: {} });
      assert(revoke.status === 200, 'revoke succeeds');

      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'delegated-after-revoke.csv' });
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, {
        apiKey: agent.apiKey, body: { on_behalf_of_principal: 'usr_alice' }
      });
      assert(approve.status === 403, 'revoked delegation is refused');
    }

    // ── N-of-M approvals ─────────────────────────────────────────────────
    console.log('\nN-of-M: intent stays pending until quorum, then approves once reached...');
    {
      const reviewer2 = await registerAgent('reviewer-layer2-b');
      promoteToReviewer(reviewer2.agentId);
      const reviewer3 = await registerAgent('reviewer-layer2-c');
      promoteToReviewer(reviewer3.agentId);

      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'nofm-quorum.csv', policy: 'finance-quorum-demo', destination: 'stripe.refund', estimated_value_usd: 100 });
      assert(p.status === 'pending_approval', 'quorum policy still requires approval');
      assert(p.requiredApprovals === 3, 'response reports the policy\'s required approver count');

      const vote1 = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(vote1.status === 200 && vote1.body.status === 'pending_approval', 'first vote alone does not approve (needs 3)');
      assert(vote1.body.votes === 1, 'reports 1 vote recorded');

      const { body: stillPending } = await req('GET', `/v1/intents/${p.intentId}`, { apiKey: reviewer.apiKey });
      assert(stillPending.status === 'pending_approval', 'intent status is still pending_approval after one vote');
      assert(stillPending.approval_state === 'waiting_input', 'approval_state stays waiting_input so more reviewers can vote');

      const execTooEarly = await req('POST', `/v1/intents/${p.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(execTooEarly.status === 409, 'execution is impossible before quorum is reached');

      const vote2 = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer2.apiKey, body: {} });
      assert(vote2.body.votes === 2, 'second distinct approver brings the count to 2');

      const sameVoterAgain = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(sameVoterAgain.body.votes === 2, 'the same reviewer voting again does not double-count');

      const vote3 = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer3.apiKey, body: {} });
      assert(vote3.status === 200 && vote3.body.status === 'approved', 'third distinct vote reaches quorum and finalizes approval');
      assert(Array.isArray(vote3.body.approvalEvidence?.proof?.voted_by) && vote3.body.approvalEvidence.proof.voted_by.length === 3, 'evidence records all three approvers');

      const execAfterQuorum = await req('POST', `/v1/intents/${p.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(execAfterQuorum.status === 201, 'execution succeeds once quorum was reached');
    }

    // ── Conditional timeout defaults ────────────────────────────────────
    console.log('\nConditional timeout default: on_no_response=reject (default) expires...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'timeout-reject.csv', expiresIn: '1s' });
      await new Promise(r => setTimeout(r, 1200));
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approve.status === 410, 'default on_no_response=reject expires the intent');
    }

    console.log('\nConditional timeout default: on_no_response=defer lets a late decision still land...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'timeout-defer.csv', policy: 'defer-on-timeout-demo', destination: 'salesforce.import', expiresIn: '1s' });
      await new Promise(r => setTimeout(r, 1200));
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approve.status === 200, 'on_no_response=defer lets the late approval proceed rather than auto-expiring');
      assert(approve.body.status === 'approved', 'intent is approved despite the TTL having elapsed');
    }

    console.log('\nConditional timeout default: on_no_response=auto_approve_if_low_risk auto-approves low-risk intents...');
    {
      const { body: p } = await proposeIntent(agent.apiKey, { payload: 'timeout-autoapprove.csv', policy: 'auto-approve-low-risk-on-timeout-demo', destination: 'salesforce.import', recordCount: 5, expiresIn: '1s' });
      assert(p.riskLevel === 'low', 'setup: this intent scores low risk');
      await new Promise(r => setTimeout(r, 1200));
      const approve = await req('POST', `/v1/intents/${p.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approve.status === 200 && approve.body.status === 'approved', 'low-risk intent auto-approves on timeout instead of expiring');
      assert(approve.body.approvalEvidence?.factor === 'timeout.auto_approve_if_low_risk.v1', 'evidence factor identifies the timeout-default approval');
    }

    // ── Approval-provider session revocation ────────────────────────────
    console.log('\nRevoking a provider\'s sessions cancels every pending interaction dispatched through it...');
    {
      const { body: p1 } = await proposeIntent(agent.apiKey, { payload: 'provider-revoke-1.csv', approval_provider: 'noop' });
      const { body: p2 } = await proposeIntent(agent.apiKey, { payload: 'provider-revoke-2.csv', approval_provider: 'noop' });
      await new Promise(r => setTimeout(r, 300));

      const revoke = await req('POST', '/v1/approval-providers/noop/revoke-sessions', { apiKey: reviewer.apiKey, body: { reason: 'provider compromised' } });
      assert(revoke.status === 200, 'revoke-sessions succeeds');
      assert(revoke.body.revokedCount >= 2, 'both pending noop interactions were revoked');

      const { body: intent1 } = await req('GET', `/v1/intents/${p1.intentId}`, { apiKey: reviewer.apiKey });
      assert(intent1.approval_state === 'cancelled', 'first intent is cancelled');
      assert(intent1.status === 'blocked', 'first intent status reflects the cancellation');

      const approveAfterRevoke = await req('POST', `/v1/intents/${p1.intentId}/approve`, { apiKey: reviewer.apiKey, body: {} });
      assert(approveAfterRevoke.status === 409, 'a session-revoked intent cannot subsequently be approved');
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
