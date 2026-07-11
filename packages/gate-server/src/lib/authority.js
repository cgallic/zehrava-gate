// Layer 2 authority model (issue #8): standing approval policies,
// delegation, N-of-M voting, and conditional timeout defaults — the parts
// A2H v1 explicitly defers past its base protocol. Gate's policy engine
// (lib/policy.js) stays the write-path enforcement layer; this module adds
// the authority/governance layer on top of it.

const db = require('./db');
const { generateId } = require('./crypto');

// ── Standing approvals ───────────────────────────────────────────────────
// "Auto-approve refunds under $25/day up to $100 total for this principal,
// until this date" — represented explicitly, revocable, and checked at
// propose time before anything falls through to manual approval.

function createStandingApproval({ destination, policyId, principalId, maxAmountUsd, dailyLimitUsd, expiresAt, createdBy }) {
  const id = generateId('stap');
  db.prepare(`
    INSERT INTO standing_approvals (id, destination, policy_id, principal_id, max_amount_usd, daily_limit_usd, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, destination, policyId || null, principalId || null, maxAmountUsd ?? null, dailyLimitUsd ?? null, expiresAt ?? null, createdBy || null, Date.now());
  return getStandingApproval(id);
}

function getStandingApproval(id) {
  const row = db.prepare('SELECT * FROM standing_approvals WHERE id = ?').get(id);
  return row ? formatStandingApproval(row) : null;
}

function listStandingApprovals() {
  return db.prepare('SELECT * FROM standing_approvals ORDER BY created_at DESC').all().map(formatStandingApproval);
}

function revokeStandingApproval(id, reason) {
  const row = db.prepare('SELECT * FROM standing_approvals WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'already_revoked' };
  db.prepare('UPDATE standing_approvals SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(Date.now(), reason || null, id);
  return { ok: true };
}

// Finds the best-matching, still-valid standing approval for an intent.
// Fails closed: any ambiguity (unknown value against a capped approval, no
// match at all) means no auto-approval, not an approval.
function findApplicableStandingApproval({ destination, principalId, estimatedValueUsd }) {
  const now = Date.now();
  const candidates = db.prepare('SELECT * FROM standing_approvals WHERE destination = ? AND revoked_at IS NULL').all(destination);
  for (const row of candidates) {
    if (row.expires_at && now > row.expires_at) continue;
    if (row.principal_id && row.principal_id !== principalId) continue;
    if (row.max_amount_usd != null && (estimatedValueUsd == null || estimatedValueUsd > row.max_amount_usd)) continue;
    if (row.daily_limit_usd != null) {
      const since = now - 24 * 3600 * 1000;
      const spentRow = db.prepare(`
        SELECT COALESCE(SUM(estimated_value_usd), 0) as total FROM proposals
        WHERE standing_approval_id = ? AND created_at >= ? AND status NOT IN ('blocked', 'expired', 'duplicate_blocked')
      `).get(row.id, since);
      if ((spentRow.total || 0) + (estimatedValueUsd || 0) > row.daily_limit_usd) continue;
    }
    return formatStandingApproval(row);
  }
  return null;
}

function formatStandingApproval(row) {
  return {
    id: row.id,
    destination: row.destination,
    policyId: row.policy_id,
    principalId: row.principal_id,
    maxAmountUsd: row.max_amount_usd,
    dailyLimitUsd: row.daily_limit_usd,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokedReason: row.revoked_reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ── Delegation ───────────────────────────────────────────────────────────
// "Alice (principal) delegates approval authority for stripe.refund up to
// $500 to agent agt_finance_bot until this date."

function createDelegation({ delegatorPrincipalId, delegateAgentId, destination, policyId, maxAmountUsd, expiresAt, createdBy }) {
  const id = generateId('deleg');
  db.prepare(`
    INSERT INTO delegations (id, delegator_principal_id, delegate_agent_id, destination, policy_id, max_amount_usd, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, delegatorPrincipalId, delegateAgentId || null, destination || null, policyId || null, maxAmountUsd ?? null, expiresAt ?? null, createdBy || null, Date.now());
  return getDelegation(id);
}

function getDelegation(id) {
  const row = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
  return row ? formatDelegation(row) : null;
}

function listDelegations() {
  return db.prepare('SELECT * FROM delegations ORDER BY created_at DESC').all().map(formatDelegation);
}

function revokeDelegation(id, reason) {
  const row = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'already_revoked' };
  db.prepare('UPDATE delegations SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(Date.now(), reason || null, id);
  return { ok: true };
}

function findApplicableDelegation({ delegatorPrincipalId, delegateAgentId, destination, policyId, estimatedValueUsd }) {
  if (!delegatorPrincipalId) return null;
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM delegations WHERE delegator_principal_id = ? AND revoked_at IS NULL').all(delegatorPrincipalId);
  for (const row of rows) {
    if (row.expires_at && now > row.expires_at) continue;
    if (row.delegate_agent_id && row.delegate_agent_id !== delegateAgentId) continue;
    if (row.destination && row.destination !== destination) continue;
    if (row.policy_id && row.policy_id !== policyId) continue;
    if (row.max_amount_usd != null && (estimatedValueUsd == null || estimatedValueUsd > row.max_amount_usd)) continue;
    return formatDelegation(row);
  }
  return null;
}

function formatDelegation(row) {
  return {
    id: row.id,
    delegatorPrincipalId: row.delegator_principal_id,
    delegateAgentId: row.delegate_agent_id,
    destination: row.destination,
    policyId: row.policy_id,
    maxAmountUsd: row.max_amount_usd,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokedReason: row.revoked_reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ── N-of-M approval voting ──────────────────────────────────────────────
// One row per distinct approving actor per intent — UNIQUE(intent_id,
// actor) makes a repeat vote from the same actor a no-op rather than a
// double-count, so quorum can't be gamed by one reviewer clicking twice.

function recordVote(intentId, actor, principalId) {
  db.prepare('INSERT OR IGNORE INTO approval_votes (id, intent_id, actor, principal_id, decided_at) VALUES (?, ?, ?, ?, ?)')
    .run(generateId('vote'), intentId, actor, principalId || null, Date.now());
  return listVotes(intentId);
}

function listVotes(intentId) {
  return db.prepare('SELECT * FROM approval_votes WHERE intent_id = ? ORDER BY decided_at ASC').all(intentId);
}

// ── Conditional timeout defaults ────────────────────────────────────────
// Policy: `on_no_response: reject | defer | auto_approve_if_low_risk`.
// Fails closed — an unset or unrecognized value behaves as `reject`.

function resolveOnNoResponse(policyObj) {
  const value = policyObj?.on_no_response;
  return ['reject', 'defer', 'auto_approve_if_low_risk'].includes(value) ? value : 'reject';
}

module.exports = {
  createStandingApproval,
  getStandingApproval,
  listStandingApprovals,
  revokeStandingApproval,
  findApplicableStandingApproval,
  createDelegation,
  getDelegation,
  listDelegations,
  revokeDelegation,
  findApplicableDelegation,
  recordVote,
  listVotes,
  resolveOnNoResponse,
};
