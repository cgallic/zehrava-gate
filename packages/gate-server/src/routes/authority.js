// Layer 2 authority model admin surface (issue #8): standing approvals,
// delegation, and approval-provider session revocation. All reviewer/
// admin-gated, same as the existing agent management endpoints.

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { APPROVAL_STATES, transitionApprovalState } = require('../lib/approval-lifecycle');
const { updateInteractionState, INTERACTION_STATES } = require('../lib/approval-ledger');
const {
  createStandingApproval, listStandingApprovals, revokeStandingApproval,
  createDelegation, listDelegations, revokeDelegation,
} = require('../lib/authority');

function requireReviewer(req, res) {
  const role = req.agent?.role || 'agent';
  if (role !== 'admin' && role !== 'reviewer') {
    res.status(403).json({ error: 'forbidden', message: 'Reviewer API key required' });
    return false;
  }
  return true;
}

// ── Standing approvals ───────────────────────────────────────────────────

// POST /v1/standing-approvals
router.post('/standing-approvals', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const { destination, policy_id, principal_id, max_amount_usd, daily_limit_usd, expires_at } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required' });

  const standing = createStandingApproval({
    destination,
    policyId: policy_id || null,
    principalId: principal_id || null,
    maxAmountUsd: max_amount_usd !== undefined ? parseFloat(max_amount_usd) : null,
    dailyLimitUsd: daily_limit_usd !== undefined ? parseFloat(daily_limit_usd) : null,
    expiresAt: expires_at ? new Date(expires_at).getTime() : null,
    createdBy: req.agent.name,
  });
  logEvent(null, 'standing_approval_created', req.agent.name, { standingApprovalId: standing.id, destination });
  res.status(201).json(standing);
});

// GET /v1/standing-approvals
router.get('/standing-approvals', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ standingApprovals: listStandingApprovals() });
});

// POST /v1/standing-approvals/:id/revoke
router.post('/standing-approvals/:id/revoke', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const result = revokeStandingApproval(req.params.id, req.body?.reason);
  if (!result.ok) {
    return res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
  }
  logEvent(null, 'standing_approval_revoked', req.agent.name, { standingApprovalId: req.params.id, reason: req.body?.reason || null });
  res.json({ id: req.params.id, revoked: true });
});

// ── Delegation ───────────────────────────────────────────────────────────

// POST /v1/delegations
router.post('/delegations', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const { delegator_principal_id, delegate_agent_id, destination, policy_id, max_amount_usd, expires_at } = req.body;
  if (!delegator_principal_id) return res.status(400).json({ error: 'delegator_principal_id is required' });

  const delegation = createDelegation({
    delegatorPrincipalId: delegator_principal_id,
    delegateAgentId: delegate_agent_id || null,
    destination: destination || null,
    policyId: policy_id || null,
    maxAmountUsd: max_amount_usd !== undefined ? parseFloat(max_amount_usd) : null,
    expiresAt: expires_at ? new Date(expires_at).getTime() : null,
    createdBy: req.agent.name,
  });
  logEvent(null, 'delegation_created', req.agent.name, { delegationId: delegation.id, delegatorPrincipalId: delegator_principal_id, delegateAgentId: delegate_agent_id || null });
  res.status(201).json(delegation);
});

// GET /v1/delegations
router.get('/delegations', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  res.json({ delegations: listDelegations() });
});

// POST /v1/delegations/:id/revoke
router.post('/delegations/:id/revoke', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const result = revokeDelegation(req.params.id, req.body?.reason);
  if (!result.ok) {
    return res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
  }
  logEvent(null, 'delegation_revoked', req.agent.name, { delegationId: req.params.id, reason: req.body?.reason || null });
  res.json({ id: req.params.id, revoked: true });
});

// ── Approval-provider session revocation ────────────────────────────────
// Cancels every still-pending/waiting approval interaction dispatched
// through a given provider — e.g. "KaiCalls credentials may be
// compromised, kill every outstanding KaiCalls approval request now."
// Gate-side cancellation is authoritative regardless of what the provider
// itself can or can't do about an already-delivered notification.

// POST /v1/approval-providers/:provider/revoke-sessions
router.post('/approval-providers/:provider/revoke-sessions', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const provider = req.params.provider;
  const reason = req.body?.reason || 'provider_session_revocation';

  const pending = db.prepare(`
    SELECT * FROM approval_interactions
    WHERE provider = ? AND state IN ('pending', 'sent', 'waiting_input')
  `).all(provider);

  const revoked = [];
  for (const interaction of pending) {
    const stateResult = updateInteractionState(interaction.id, INTERACTION_STATES.CANCELLED);
    if (!stateResult.ok) continue;
    const proposalTransition = transitionApprovalState(interaction.intent_id, APPROVAL_STATES.CANCELLED, { actor: req.agent.name, reason });
    if (proposalTransition.ok) {
      db.prepare("UPDATE proposals SET status = 'blocked', block_reason = ? WHERE id = ?").run(reason, interaction.intent_id);
    }
    logEvent(interaction.intent_id, 'approval_provider_session_revoked', req.agent.name, { provider, interactionId: interaction.id, reason });
    revoked.push({ intentId: interaction.intent_id, interactionId: interaction.id });
  }

  res.json({ provider, revokedCount: revoked.length, revoked });
});

module.exports = router;
