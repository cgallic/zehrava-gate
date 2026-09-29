/**
 * A2H Layer 2 (draft) — POLICY / REVOKE / DELEGATE messages mapped onto
 * Gate's authority model. Wire format: docs/a2h-layer2-proposal.md.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/a2h-layer2.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39950 + (process.pid % 40);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-a2h-l2-test-'));

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function req(method, p, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const PRINCIPAL = 'did:example:alice';
const inAWeek = () => new Date(Date.now() + 7 * 86400 * 1000).toISOString();
const consent = { factor: 'passkey.webauthn.v1', proof: { note: 'gateway-attested consent' } };

function policyMessage(overrides = {}, policyOverrides = {}) {
  return {
    a2h_version: '1.2',
    type: 'POLICY',
    message_id: `msg_${crypto.randomUUID()}`,
    principal_id: PRINCIPAL,
    agent_id: 'did:web:crm-agent.example.com',
    created_at: new Date().toISOString(),
    policy: {
      effect: 'AUTO_APPROVE',
      action_class: 'salesforce.import',
      conditions: {
        max_amount: { value: 100, currency: 'USD' },
        window_limits: [{ period_sec: 86400, max_total: { value: 150, currency: 'USD' } }],
      },
      expires_at: inAWeek(),
      ...policyOverrides,
    },
    evidence: consent,
    ...overrides,
  };
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '', GATE_A2H_COMPAT: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    const start = Date.now();
    while (true) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
      if (Date.now() - start > 10000) throw new Error('Server did not become healthy in time');
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log('\n  A2H Layer 2 (draft) — POLICY / REVOKE / DELEGATE');
    console.log('  ═══════════════════════════════════════════════\n');

    const agent = (await req('POST', '/v1/agents/register', { body: { name: 'agent-l2', riskTier: 'standard' } })).body;
    const reviewer = (await req('POST', '/v1/agents/register', { body: { name: 'reviewer-l2', riskTier: 'standard' } })).body;
    const approver = (await req('POST', '/v1/agents/register', { body: { name: 'approver-bob', riskTier: 'standard' } })).body;
    process.env.DATA_DIR = DATA_DIR;
    require('../src/lib/db').prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

    const l2 = (body, apiKey = reviewer.apiKey) => req('POST', '/v1/a2h/layer2', { apiKey, body });
    const propose = (overrides) => req('POST', '/v1/intents', {
      apiKey: agent.apiKey,
      body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: `leads-${crypto.randomUUID()}.csv`, principal_id: PRINCIPAL, ...overrides },
    });

    console.log('Discovery advertises the Layer 2 draft...');
    {
      const gate = (await req('GET', '/.well-known/gate')).body;
      assert(gate.a2h_layer2?.endpoint === '/v1/a2h/layer2' && gate.a2h_layer2.types.includes('POLICY'), '/.well-known/gate lists the Layer 2 endpoint and types');
      const a2h = (await req('GET', '/.well-known/a2h')).body;
      assert(a2h.layer2?.draft === 'zehrava-a2h-l2-draft-01', '/.well-known/a2h advertises the draft version');
    }

    console.log('\nPOLICY grants a bounded standing approval...');
    let policyId;
    {
      const msg = policyMessage();
      const r = await l2(msg);
      assert(r.status === 201 && r.body.type === 'RESULT' && r.body.responds_to === msg.message_id, 'POLICY → 201 RESULT responding to the message_id');
      policyId = r.body.result.policy_id;
      assert(/^stap_/.test(policyId || '') && r.body.result.state === 'ACTIVE', 'returns the Gate policy id, ACTIVE');
      const sa = r.body.result.standing_approval;
      assert(sa.principalId === PRINCIPAL && sa.maxAmountUsd === 100 && sa.dailyLimitUsd === 150 && !!sa.expiresAt, 'bounds, principal and expiry carried over exactly');

      const replay = await l2(msg);
      assert(replay.status === 200 && replay.body.duplicate === true && replay.body.result.policy_id === policyId, 'replayed message_id returns the original result, no second grant');
      const list = (await req('GET', '/v1/standing-approvals', { apiKey: reviewer.apiKey })).body.standingApprovals;
      assert(list.filter((s) => s.principalId === PRINCIPAL).length === 1, 'exactly one standing approval exists');

    }

    console.log('\nThe policy is enforced at decision time...');
    {
      const under = await propose({ estimated_value_usd: 60 });
      assert(under.body.status === 'approved' && under.body.standingApprovalId === policyId, 'intent within bounds auto-approved, citing the policy');
      const over = await propose({ estimated_value_usd: 120 });
      assert(over.body.status === 'pending_approval', 'over max_amount → falls back to a human');
      const window = await propose({ estimated_value_usd: 95 });
      assert(window.body.status === 'pending_approval', '24h window limit (60 + 95 > 150) → falls back to a human');
      const otherPrincipal = await propose({ estimated_value_usd: 10, principal_id: 'did:example:mallory' });
      assert(otherPrincipal.body.status === 'pending_approval', 'policy does not apply to another principal');
    }

    console.log('\nFail closed on anything Gate cannot enforce exactly...');
    {
      const eur = await l2(policyMessage({}, { conditions: { max_amount: { value: 100, currency: 'EUR' } } }));
      assert(eur.status === 422 && eur.body.error?.code === 'ERR.UNSUPPORTED_CONDITION', 'non-USD amount → 422 ERR.UNSUPPORTED_CONDITION');
      const unknownCond = await l2(policyMessage({}, { conditions: { max_amount: { value: 10, currency: 'USD' }, business_hours_only: true } }));
      assert(unknownCond.status === 422 && unknownCond.body.error.conditions?.includes('business_hours_only'), 'unknown condition is rejected, never silently dropped');
      const weekly = await l2(policyMessage({}, { conditions: { window_limits: [{ period_sec: 604800, max_total: { value: 500, currency: 'USD' } }] } }));
      assert(weekly.status === 422, 'unsupported window period → 422');
      const unbounded = await l2(policyMessage({}, { conditions: {} }));
      assert(unbounded.status === 400, 'AUTO_APPROVE with no bound at all → 400');
      const forever = await l2(policyMessage({}, { expires_at: undefined }));
      assert(forever.status === 400 && /expires_at/.test(forever.body.error.message), 'policy without expires_at → 400 (standing authority must expire)');
      const deny = await l2(policyMessage({}, { effect: 'DENY' }));
      assert(deny.status === 422, 'effect other than AUTO_APPROVE → 422 (boundaries are SCOPE)');
      const noConsent = await l2(policyMessage({ evidence: undefined }));
      assert(noConsent.status === 400, 'POLICY without the principal\'s consent evidence → 400');
      const stale = await l2(policyMessage({ created_at: new Date(Date.now() - 3600 * 1000).toISOString() }));
      assert(stale.status === 409 && stale.body.error.code === 'ERR.REPLAY_REJECTED', 'stale created_at → ERR.REPLAY_REJECTED');
      const notReviewer = await l2(policyMessage(), agent.apiKey);
      assert(notReviewer.status === 403, 'plain agent key cannot grant itself standing authority');
      const badType = await l2({ ...policyMessage(), type: 'SCOPE' });
      assert(badType.status === 400, 'unknown/unsupported message type → 400');
    }

    console.log('\nREVOKE is immediate and owner-bound...');
    {
      const wrongOwner = await l2({ type: 'REVOKE', message_id: `msg_${crypto.randomUUID()}`, principal_id: 'did:example:mallory', target: { type: 'POLICY', id: policyId } });
      assert(wrongOwner.status === 403, 'another principal cannot revoke Alice\'s policy');
      const r = await l2({ type: 'REVOKE', message_id: `msg_${crypto.randomUUID()}`, principal_id: PRINCIPAL, target: { type: 'POLICY', id: policyId }, reason: 'trip cancelled' });
      assert(r.status === 200 && r.body.result.state === 'REVOKED', 'REVOKE → REVOKED');
      const after = await propose({ estimated_value_usd: 5 });
      assert(after.body.status === 'pending_approval', 'next intent after revocation needs a human');
      const again = await l2({ type: 'REVOKE', message_id: `msg_${crypto.randomUUID()}`, principal_id: PRINCIPAL, target: { type: 'POLICY', id: policyId } });
      assert(again.status === 409 && again.body.error.code === 'ERR.CONFLICT', 'revoking twice → ERR.CONFLICT');
      const missing = await l2({ type: 'REVOKE', message_id: `msg_${crypto.randomUUID()}`, target: { type: 'POLICY', id: 'stap_nope' } });
      assert(missing.status === 404, 'unknown target → 404');
    }

    console.log('\nDELEGATE lets another approver answer for the principal...');
    {
      const r = await l2({
        type: 'DELEGATE', message_id: `msg_${crypto.randomUUID()}`, principal_id: PRINCIPAL, evidence: consent,
        delegation: { delegate_id: approver.agentId, action_class: 'salesforce.import', conditions: { max_amount: { value: 1000, currency: 'USD' } }, expires_at: inAWeek() },
      });
      assert(r.status === 201 && /^deleg_/.test(r.body.result.delegation_id || ''), 'DELEGATE → 201 with a delegation id');
      const d = r.body.result.delegation;
      assert(d.delegatorPrincipalId === PRINCIPAL && d.delegateAgentId === approver.agentId && d.maxAmountUsd === 1000, 'delegation bound to principal, delegate and cap');
      const listed = (await req('GET', '/v1/delegations', { apiKey: reviewer.apiKey })).body.delegations;
      assert(listed.some((x) => x.id === r.body.result.delegation_id), 'visible through the existing delegations API');

      const forSomeoneElse = await l2({
        type: 'DELEGATE', message_id: `msg_${crypto.randomUUID()}`, principal_id: PRINCIPAL, evidence: consent,
        delegation: { delegator_principal_id: 'did:example:carol', delegate_id: approver.agentId, expires_at: inAWeek() },
      });
      assert(forSomeoneElse.status === 403, 'a principal cannot delegate someone else\'s authority');

      const rev = await l2({ type: 'REVOKE', message_id: `msg_${crypto.randomUUID()}`, principal_id: PRINCIPAL, target: { type: 'DELEGATION', id: r.body.result.delegation_id } });
      assert(rev.status === 200, 'REVOKE DELEGATION → 200');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
