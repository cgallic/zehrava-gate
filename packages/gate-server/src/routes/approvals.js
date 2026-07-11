const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const db = require('../lib/db');
const { generateId, generateDeliveryToken } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { RunLedger } = require('../lib/runs');
const { EVENT_TYPES } = require('../lib/runs/constants');
const { APPROVAL_STATES, isTerminal, transitionApprovalState } = require('../lib/approval-lifecycle');
const { buildApprovalEvidence, canonicalIntentHash } = require('../lib/evidence');
const { consumeNonce, checkTimestampTolerance } = require('../lib/replay');
const { getInteraction, getLatestInteractionForIntent, updateInteractionState, INTERACTION_STATES } = require('../lib/approval-ledger');
const { verifyProviderSignature, computeSignature } = require('../lib/provider-signature');
const { loadPolicy } = require('../lib/policy');
const { findApplicableDelegation, recordVote, listVotes, resolveOnNoResponse } = require('../lib/authority');

// Auto-delivery destinations — approve triggers immediate deliver
const AUTO_DELIVER_DESTINATIONS = ['blog.publish', 'gmail.send', 'loops.send'];

function autoDeliver(proposalId, destination, deliveryToken) {
  execFile('python3', [
    '/opt/cmo-analytics/gate_delivery_worker.py'
  ], { env: { ...process.env } }, (err, stdout, stderr) => {
    if (err) console.error(`[gate] auto-deliver failed for ${proposalId}:`, err.message);
    else console.log(`[gate] auto-delivered ${proposalId} → ${destination}`);
  });
}

// ── WEBHOOK SYSTEM (DB-backed, signed, bounded retry — issue #6) ──────────
//
// Every delivery attempt carries a stable delivery ID (X-Gate-Delivery-ID)
// and, when the registration included a secret, a timestamped HMAC
// (X-Gate-Signature: t=<ms>,v1=<hex-hmac-sha256 of "${t}.${rawBody}">) —
// the same scheme lib/provider-signature.js uses for inbound callbacks, so
// one verification routine works both directions. A receiver should:
//
//   const [t, v1] = sig.split(',').map(kv => kv.split('=')[1]);
//   const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
//   if (!timingSafeEqual(expected, v1)) reject();
//   if (Math.abs(Date.now() - Number(t)) > toleranceMs) reject();
//
// Non-2xx/unreachable deliveries retry on a bounded exponential schedule
// (GATE_WEBHOOK_RETRY_DELAYS_MS, default "0,5000,30000,120000,600000" —
// five total attempts) before the webhook is marked permanently `failed`.
// GET /v1/intents/:id / GET /v1/executions/:id remain the polling fallback
// if webhooks never succeed.

const WEBHOOK_RETRY_DELAYS_MS = (process.env.GATE_WEBHOOK_RETRY_DELAYS_MS || '0,5000,30000,120000,600000')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);

function registerWebhook(intentId, url, secret) {
  const existing = db.prepare("SELECT id FROM webhooks WHERE intent_id = ? AND status = 'pending'").get(intentId);
  if (existing) {
    db.prepare('UPDATE webhooks SET url = ?, secret = ? WHERE id = ?')
      .run(url, secret || null, existing.id);
    return existing.id;
  }
  const id = generateId('whk');
  db.prepare("INSERT INTO webhooks (id, intent_id, url, secret, fired, status, attempts, created_at) VALUES (?, ?, ?, ?, 0, 'pending', 0, ?)")
    .run(id, intentId, url, secret || null, Date.now());
  return id;
}

// Single delivery attempt. Resolves { success, statusCode, error } — never
// rejects, so the retry scheduler always gets a clean result to act on.
function deliverOnce(hook, rawBody) {
  return new Promise(async (resolve) => {
    let req;
    try {
      const { default: https } = await import('https');
      const { default: http } = await import('http');
      const { URL } = await import('url');
      const u = new URL(hook.url);
      const lib = u.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'X-Gate-Delivery-ID': hook.delivery_id,
      };
      if (hook.secret) {
        headers['X-Gate-Secret'] = hook.secret; // backward-compat with pre-#6 consumers
        const t = Date.now();
        headers['X-Gate-Signature'] = `t=${t},v1=${computeSignature(hook.secret, t, rawBody)}`;
      }

      req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
        timeout: 8000,
      });
    } catch (e) {
      return resolve({ success: false, error: `invalid_webhook_url: ${e.message}` });
    }

    req.on('response', (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ success, statusCode: res.statusCode, error: success ? null : `http_${res.statusCode}` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(rawBody);
    req.end();
  });
}

async function attemptDelivery(webhookId, event, data, attemptIndex) {
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
  if (!hook || hook.status !== 'pending') return; // cancelled/already-terminal — nothing to do

  const payload = JSON.stringify({
    intentId: hook.intent_id,
    event,
    actor: data.approver || data.rejector || 'system',
    firedAt: new Date().toISOString(),
    deliveryId: hook.delivery_id,
    attempt: attemptIndex + 1,
    ...data,
  });

  const result = await deliverOnce(hook, payload);
  const attempts = attemptIndex + 1;

  if (result.success) {
    db.prepare("UPDATE webhooks SET fired = 1, fired_at = ?, status = 'delivered', attempts = ?, last_error = NULL WHERE id = ?")
      .run(Date.now(), attempts, webhookId);
    logEvent(hook.intent_id, 'webhook_delivered', 'system', { webhookId, event, attempts, deliveryId: hook.delivery_id });
    return;
  }

  logEvent(hook.intent_id, 'webhook_attempt_failed', 'system', { webhookId, event, attempt: attempts, error: result.error });

  if (attempts >= WEBHOOK_RETRY_DELAYS_MS.length) {
    db.prepare("UPDATE webhooks SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, result.error, webhookId);
    logEvent(hook.intent_id, 'webhook_failed', 'system', { webhookId, event, attempts, error: result.error });
    return;
  }

  db.prepare('UPDATE webhooks SET attempts = ?, last_error = ? WHERE id = ?').run(attempts, result.error, webhookId);
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempts];
  const timer = setTimeout(() => attemptDelivery(webhookId, event, data, attempts), delay);
  if (typeof timer.unref === 'function') timer.unref();
}

function fireWebhook(intentId, event, data) {
  const hook = db.prepare("SELECT * FROM webhooks WHERE intent_id = ? AND status = 'pending'").get(intentId);
  if (!hook) return;
  if (!hook.delivery_id) {
    db.prepare('UPDATE webhooks SET delivery_id = ? WHERE id = ?').run(generateId('del'), hook.id);
  }
  setImmediate(() => attemptDelivery(hook.id, event, data, 0));
}

// ── APPROVE ───────────────────────────────────────────────────────────────

function requireReviewer(req, res) {
  const role = req.agent?.role || 'agent';
  if (role !== 'admin' && role !== 'reviewer') {
    res.status(403).json({ error: 'forbidden', message: 'Reviewer API key required for approvals' });
    return false;
  }
  return true;
}

// Replay guards shared by dashboard (authenticated) and approval-link
// (token-authenticated) decision endpoints. Returns an error descriptor or
// null if the request may proceed.
function checkReplayGuards({ nonce, timestamp }) {
  if (nonce !== undefined) {
    const n = consumeNonce(nonce);
    if (!n.valid) return { httpStatus: 409, body: { error: 'replay_rejected', reason: n.reason } };
  }
  if (timestamp !== undefined) {
    const t = checkTimestampTolerance(timestamp);
    if (!t.valid) return { httpStatus: 409, body: { error: 'replay_rejected', reason: t.reason } };
  }
  return null;
}

// Approval-interaction state guard: refuses to answer an interaction that
// has already left the pending/waiting_input phase (answered/cancelled/
// expired/failed), independent of the intent's own status field. This is
// the backstop that stops an already-approved intent from later being
// rejected (or vice versa) and stops a second decision channel (e.g. an
// unused approval link) from re-firing side effects after the intent was
// already answered through a different channel.
function guardApprovalInteraction(proposal) {
  const state = proposal.approval_state || APPROVAL_STATES.PENDING;
  if (state === APPROVAL_STATES.CANCELLED) {
    return { httpStatus: 409, body: { error: 'approval_cancelled', message: 'This approval request was cancelled' } };
  }
  if (state === APPROVAL_STATES.FAILED) {
    return { httpStatus: 409, body: { error: 'approval_failed', message: 'This approval request failed and cannot be answered' } };
  }
  if (state === APPROVAL_STATES.EXPIRED) {
    return { httpStatus: 410, body: { error: 'approval_expired', message: 'This approval request has expired' } };
  }
  if (state === APPROVAL_STATES.ANSWERED) {
    return {
      httpStatus: 409,
      body: {
        error: 'already_answered',
        message: 'This approval request has already been answered',
        decision: proposal.status === 'approved' ? 'APPROVE' : 'REJECT',
      },
    };
  }
  return null;
}

// Shared decision core — everything that happens once an approve/reject is
// actually admitted (state/replay/expiry guards already passed). Used by
// both the API-key-authenticated dashboard endpoints and the single-use
// approval-link endpoints so side effects (evidence, webhooks, gate_exec,
// hold-queue release, auto-deliver) never drift apart between the two paths.
function executeApproveDecision(proposal, { actor, factor = 'manual.dashboard.v1', principalId, delegation }) {
  const proposalId = proposal.id;

  // N-of-M approval (issue #8): a policy can require multiple distinct
  // approvers. Each call records one vote; only once quorum is reached does
  // the intent actually transition to approved — every guard that already
  // ran (replay, interaction-state, expiry) applies per vote, and
  // approval_state deliberately stays WAITING_INPUT until quorum so
  // additional reviewers can still act.
  const requiredApprovals = proposal.required_approvals || 1;
  if (requiredApprovals > 1) {
    const votes = recordVote(proposalId, actor, principalId || null);
    if (votes.length < requiredApprovals) {
      logEvent(proposalId, 'approval_vote_recorded', actor, { votes: votes.length, required: requiredApprovals });
      return {
        status: 'pending_approval',
        approvalState: APPROVAL_STATES.WAITING_INPUT,
        intentId: proposalId,
        votes: votes.length,
        requiredApprovals,
        votedBy: votes.map((v) => v.actor),
      };
    }
    logEvent(proposalId, 'approval_quorum_reached', actor, { votes: votes.length, required: requiredApprovals });
  }

  const deliveryToken = generateDeliveryToken();
  db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);
  db.prepare(`
    INSERT INTO manifests (id, proposal_id, signed_by, delivery_token)
    VALUES (?, ?, ?, ?)
  `).run(generateId('mfst'), proposalId, actor, deliveryToken);

  transitionApprovalState(proposalId, APPROVAL_STATES.ANSWERED, { actor, reason: 'approved' });
  const freshProposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  const votedBy = requiredApprovals > 1 ? listVotes(proposalId).map((v) => v.actor) : undefined;
  const evidence = buildApprovalEvidence(freshProposal, { decision: 'APPROVE', factor, actor, delegation, votedBy });

  logEvent(proposalId, 'approved', actor, { approver: actor });
  fireWebhook(proposalId, 'approved', { approver: actor });

  if (proposal.on_behalf_of) {
    const runs = db.prepare('SELECT * FROM run_ledgers WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
      .all(proposal.on_behalf_of, 'active');
    if (runs.length > 0) {
      RunLedger.recordEvent({
        ledgerId: runs[0].id,
        eventType: EVENT_TYPES.APPROVAL_RECEIVED,
        actorId: proposal.on_behalf_of,
        payload: { intentId: proposalId, approver: actor }
      });
    }
  }

  const { hasCredential } = require('../proxy/vault');
  const { executeIntent } = require('../proxy/executor');
  const isGateExec = hasCredential(proposal.destination) && process.env.PROXY_API_KEY;

  try {
    const holdQueue = require('../proxy/hold-queue');
    const held = holdQueue.release(proposalId);
    if (held) {
      console.log(`[hold-queue] release ${proposalId} (${held.request?.type || 'http'})`);
      try { held.resolve(); } catch (e) { console.error('[hold-queue] resolve error:', e.message); }
    }
  } catch {}

  if (isGateExec) {
    setImmediate(async () => {
      try {
        let payloadContent = null;
        if (proposal.payload_path) {
          const fs = require('fs');
          try { payloadContent = fs.readFileSync(proposal.payload_path, 'utf8'); } catch {}
        }
        const result = await executeIntent({ id: proposalId, destination: proposal.destination, payloadContent });
        console.log(`[gate_exec] ${proposalId} → ${result.succeeded ? 'succeeded' : 'failed'} (HTTP ${result.httpStatus})`);
      } catch (e) {
        console.error(`[gate_exec] Error executing ${proposalId}:`, e.message);
      }
    });
  } else if (AUTO_DELIVER_DESTINATIONS.includes(proposal.destination)) {
    autoDeliver(proposalId, proposal.destination, deliveryToken);
  }

  return {
    status: 'approved',
    approvalState: APPROVAL_STATES.ANSWERED,
    approvedAt: new Date().toISOString(),
    intentId: proposalId,
    deliveryToken,
    autoDeliver: isGateExec ? false : AUTO_DELIVER_DESTINATIONS.includes(proposal.destination),
    gate_exec: isGateExec,
    approvalEvidence: evidence,
  };
}

function executeRejectDecision(proposal, { actor, reason, factor = 'manual.dashboard.v1' }) {
  const proposalId = proposal.id;
  db.prepare("UPDATE proposals SET status = 'blocked', block_reason = ? WHERE id = ?")
    .run(reason || 'Rejected by reviewer', proposalId);
  transitionApprovalState(proposalId, APPROVAL_STATES.ANSWERED, { actor, reason: 'rejected' });
  const freshProposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  const evidence = buildApprovalEvidence(freshProposal, { decision: 'REJECT', factor, actor });

  try {
    const holdQueue = require('../proxy/hold-queue');
    holdQueue.cancel(proposalId, reason || 'rejected');
  } catch {}

  logEvent(proposalId, 'rejected', actor, { reason, rejector: actor });
  fireWebhook(proposalId, 'rejected', { reason, rejector: actor });

  return { status: 'blocked', approvalState: APPROVAL_STATES.ANSWERED, reason, approvalEvidence: evidence };
}

// Conditional timeout default (issue #8): consults policy.on_no_response
// once an intent's TTL has elapsed. 'reject' (the default — fail closed)
// marks it expired; 'defer' lets the caller's actual decision proceed as if
// not expired; 'auto_approve_if_low_risk' auto-approves low-risk intents
// instead of expiring them. Returns null when not expired at all.
function checkExpiryWithPolicy(proposal) {
  if (!proposal.expires_at || Date.now() <= proposal.expires_at) return null;

  const policyObj = loadPolicy(proposal.policy_id);
  const onNoResponse = resolveOnNoResponse(policyObj);

  if (onNoResponse === 'defer') {
    logEvent(proposal.id, 'expiry_deferred', 'system', { on_no_response: 'defer' });
    return { deferred: true };
  }
  if (onNoResponse === 'auto_approve_if_low_risk' && proposal.risk_level === 'low') {
    return { autoApprove: true };
  }

  db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposal.id);
  transitionApprovalState(proposal.id, APPROVAL_STATES.EXPIRED, { actor: 'system', reason: `ttl_elapsed_on_no_response_${onNoResponse}` });
  logEvent(proposal.id, 'expired', 'system', { on_no_response: onNoResponse });
  return { expired: true };
}

// Delegation (issue #8): an on_behalf_of_principal field means "I, the
// authenticated agent, am acting as a delegate for this principal's
// approval authority." Requires an active, matching, non-revoked
// delegation — evidence records both the principal and the delegate agent.
function resolveDelegation(req, proposal) {
  if (!req.body.on_behalf_of_principal) return { delegation: null, error: null };
  const delegation = findApplicableDelegation({
    delegatorPrincipalId: req.body.on_behalf_of_principal,
    delegateAgentId: req.agent.id,
    destination: proposal.destination,
    policyId: proposal.policy_id,
    estimatedValueUsd: proposal.estimated_value_usd,
  });
  if (!delegation) {
    return {
      delegation: null,
      error: { httpStatus: 403, body: { error: 'delegation_not_found', message: `No active delegation from ${req.body.on_behalf_of_principal} to this agent for this action` } },
    };
  }
  return { delegation, error: null };
}

// POST /v1/approve  (V1 backward compat — body.proposalId)
router.post('/approve', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const { proposalId, nonce, decided_at } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (proposal.status === 'blocked') {
    return res.status(409).json({ error: 'Cannot approve a blocked proposal' });
  }
  if (proposal.status === 'delivered') {
    return res.status(409).json({ error: 'Proposal already delivered' });
  }
  if (proposal.status === 'approved') {
    const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(proposalId);
    return res.json({
      status: 'approved',
      approvedAt: new Date().toISOString(),
      intentId: proposalId,
      deliveryToken: manifest?.delivery_token
    });
  }

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  const replayError = checkReplayGuards({ nonce, timestamp: decided_at });
  if (replayError) return res.status(replayError.httpStatus).json(replayError.body);

  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    const outcome = checkExpiryWithPolicy(proposal);
    if (outcome.expired) return res.status(410).json({ error: 'Proposal has expired' });
    if (outcome.autoApprove) {
      return res.json(executeApproveDecision(proposal, { actor: 'system:timeout_default', factor: 'timeout.auto_approve_if_low_risk.v1' }));
    }
    // deferred: fall through and let the reviewer's actual decision proceed
  }

  const { delegation, error: delegationError } = resolveDelegation(req, proposal);
  if (delegationError) return res.status(delegationError.httpStatus).json(delegationError.body);

  res.json(executeApproveDecision(proposal, {
    actor: req.agent.name,
    principalId: req.body.on_behalf_of_principal || req.body.principal_id || null,
    delegation,
  }));
});

// ── REJECT ────────────────────────────────────────────────────────────────

// POST /v1/reject  (V1 backward compat — body.proposalId)
router.post('/reject', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const { proposalId, reason, nonce, decided_at } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (['blocked', 'delivered', 'expired'].includes(proposal.status)) {
    return res.status(409).json({ error: `Cannot reject proposal with status: ${proposal.status}` });
  }

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  const replayError = checkReplayGuards({ nonce, timestamp: decided_at });
  if (replayError) return res.status(replayError.httpStatus).json(replayError.body);

  res.json(executeRejectDecision(proposal, { actor: req.agent.name, reason }));
});

// ── CANCEL ───────────────────────────────────────────────────────────────

// POST /v1/intents/:id/cancel-approval
router.post('/intents/:id/cancel-approval', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const proposalId = req.params.id;
  const { reason } = req.body || {};

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Intent not found' });

  const state = proposal.approval_state || APPROVAL_STATES.PENDING;
  if (isTerminal(state)) {
    return res.status(409).json({
      error: 'cannot_cancel',
      message: `Approval interaction already ${state} — only pending/waiting_input approvals can be cancelled`,
      approvalState: state
    });
  }

  const transition = transitionApprovalState(proposalId, APPROVAL_STATES.CANCELLED, {
    actor: req.agent.name,
    reason: reason || 'cancelled_by_reviewer'
  });
  if (!transition.ok) {
    return res.status(409).json({ error: transition.reason, approvalState: transition.previous });
  }

  db.prepare("UPDATE proposals SET status = 'blocked', block_reason = ? WHERE id = ?")
    .run(reason || 'Approval request cancelled', proposalId);

  try {
    const holdQueue = require('../proxy/hold-queue');
    holdQueue.cancel(proposalId, reason || 'approval_cancelled');
  } catch {}

  logEvent(proposalId, 'approval_cancelled', req.agent.name, { reason: reason || null });
  fireWebhook(proposalId, 'approval_cancelled', { reason: reason || null, actor: req.agent.name });

  res.json({ status: 'blocked', approvalState: APPROVAL_STATES.CANCELLED, reason: reason || null });
});

// ── APPROVAL LINKS (single-use, unauthenticated by API key — the token IS the auth) ──

function loadByApprovalLinkToken(token) {
  const proposal = db.prepare('SELECT * FROM proposals WHERE approval_link_token = ?').get(token);
  if (!proposal) return { error: { httpStatus: 404, body: { error: 'invalid_link', message: 'Unknown or invalid approval link' } } };
  if (proposal.approval_link_used_at) {
    return { error: { httpStatus: 410, body: { error: 'link_already_used', message: 'This approval link has already been used' } } };
  }
  if (proposal.approval_link_expires_at && Date.now() > proposal.approval_link_expires_at) {
    return { error: { httpStatus: 410, body: { error: 'link_expired', message: 'This approval link has expired' } } };
  }
  return { proposal };
}

// Marks the link consumed. Uses an UPDATE ... WHERE used_at IS NULL guard so
// two concurrent requests racing on the same single-use link can't both win.
function consumeApprovalLinkToken(proposalId) {
  const result = db.prepare('UPDATE proposals SET approval_link_used_at = ? WHERE id = ? AND approval_link_used_at IS NULL')
    .run(Date.now(), proposalId);
  return result.changes === 1;
}

// GET /v1/approval-links/:token — render-safe summary for an approval page
router.get('/approval-links/:token', (req, res) => {
  const { proposal, error } = loadByApprovalLinkToken(req.params.token);
  if (error) return res.status(error.httpStatus).json(error.body);

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  res.json({
    intentId: proposal.id,
    messageId: proposal.message_id,
    destination: proposal.destination,
    action: proposal.action || proposal.destination,
    policy: proposal.policy_id,
    riskScore: proposal.risk_score,
    riskLevel: proposal.risk_level,
    approvalState: proposal.approval_state,
    expiresAt: proposal.expires_at ? new Date(proposal.expires_at).toISOString() : null,
  });
});

// POST /v1/approval-links/:token/approve
router.post('/approval-links/:token/approve', (req, res) => {
  const { proposal, error } = loadByApprovalLinkToken(req.params.token);
  if (error) return res.status(error.httpStatus).json(error.body);

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  const replayError = checkReplayGuards({ nonce: req.body?.nonce, timestamp: req.body?.decided_at });
  if (replayError) return res.status(replayError.httpStatus).json(replayError.body);

  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    const outcome = checkExpiryWithPolicy(proposal);
    if (outcome.expired) return res.status(410).json({ error: 'Proposal has expired' });
    if (outcome.autoApprove) {
      if (!consumeApprovalLinkToken(proposal.id)) {
        return res.status(410).json({ error: 'link_already_used', message: 'This approval link has already been used' });
      }
      return res.json(executeApproveDecision(proposal, { actor: 'system:timeout_default', factor: 'timeout.auto_approve_if_low_risk.v1' }));
    }
    // deferred: fall through and let the caller's actual decision proceed
  }

  if (!consumeApprovalLinkToken(proposal.id)) {
    return res.status(410).json({ error: 'link_already_used', message: 'This approval link has already been used' });
  }

  res.json(executeApproveDecision(proposal, { actor: 'approval_link', factor: 'link.single_use.v1' }));
});

// POST /v1/approval-links/:token/reject
router.post('/approval-links/:token/reject', (req, res) => {
  const { proposal, error } = loadByApprovalLinkToken(req.params.token);
  if (error) return res.status(error.httpStatus).json(error.body);

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  const replayError = checkReplayGuards({ nonce: req.body?.nonce, timestamp: req.body?.decided_at });
  if (replayError) return res.status(replayError.httpStatus).json(replayError.body);

  if (!consumeApprovalLinkToken(proposal.id)) {
    return res.status(410).json({ error: 'link_already_used', message: 'This approval link has already been used' });
  }

  res.json(executeRejectDecision(proposal, { actor: 'approval_link', reason: req.body?.reason, factor: 'link.single_use.v1' }));
});

// ── WEBHOOK REGISTRATION ──────────────────────────────────────────────────

// POST /v1/webhooks/register
router.post('/webhooks/register', authenticate, (req, res) => {
  const intentId = req.body.intentId || req.body.proposalId;
  const { url, secret } = req.body;
  if (!intentId || !url) {
    return res.status(400).json({ error: 'intentId and url are required' });
  }
  const proposal = db.prepare('SELECT id FROM proposals WHERE id = ?').get(intentId);
  if (!proposal) return res.status(404).json({ error: 'Intent not found' });

  const whkId = registerWebhook(intentId, url, secret);
  res.json({ registered: true, webhookId: whkId, intentId, url });
});

// ── SIGNED PROVIDER APPROVAL CALLBACKS (issue #14) ─────────────────────────
//
// External approval only matters if Gate can verify the callback/response
// is authentic, fresh, single-use, and bound to the exact original intent.
// This route is the generalized verifier: it works for any provider that
// itself issues a signed decision (KaiCalls' notify-only integration never
// calls this — see lib/approval-providers/kaicalls.js — but a future A2H/
// Ola bridge, issue #7, or a Slack/chat-button provider would).
//
// POST /v1/approval-callbacks/:provider
// Headers: X-Gate-Provider-Signature: t=<ms>,v1=<hex-hmac>
//          X-Gate-Provider-Delivery-ID: <unique-per-delivery>  (optional but recommended)
// Body: { intent_id, gate_approval_interaction_id?, responds_to, decision,
//         decided_at, approved_intent_hash, evidence: { factors, proof } }

function recordDelivery(provider, deliveryId, intentId) {
  if (!deliveryId) return { duplicate: false };
  try {
    db.prepare('INSERT INTO provider_callback_deliveries (id, provider, delivery_id, intent_id, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(generateId('pcd'), provider, deliveryId, intentId || null, Date.now());
    return { duplicate: false };
  } catch (e) {
    return { duplicate: true };
  }
}

router.post('/approval-callbacks/:provider', (req, res) => {
  const providerName = req.params.provider;
  const body = req.body || {};
  const deliveryId = req.headers['x-gate-provider-delivery-id'] || body.delivery_id || null;

  // Dedup first — a replayed delivery should never even reach signature
  // verification/state mutation twice, regardless of whether the signature
  // on the replay is (still) valid.
  const { duplicate } = recordDelivery(providerName, deliveryId, body.intent_id);
  if (duplicate) {
    return res.status(409).json({ error: 'duplicate_delivery', message: 'This delivery_id has already been processed' });
  }

  const sig = verifyProviderSignature({
    provider: providerName,
    header: req.headers['x-gate-provider-signature'],
    rawBody: req.rawBody,
  });
  if (!sig.valid) {
    logEvent(body.intent_id || null, 'provider_callback_rejected', `provider:${providerName}`, { reason: sig.reason });
    return res.status(401).json({ error: 'invalid_signature', reason: sig.reason });
  }

  const { intent_id, gate_approval_interaction_id, responds_to, decision, decided_at, approved_intent_hash, evidence, reason } = body;
  if (!intent_id || !decision) {
    return res.status(400).json({ error: 'invalid_payload', message: 'intent_id and decision are required' });
  }

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(intent_id);
  if (!proposal) return res.status(404).json({ error: 'intent_not_found' });

  const interaction = gate_approval_interaction_id
    ? getInteraction(gate_approval_interaction_id)
    : getLatestInteractionForIntent(intent_id);
  if (!interaction || interaction.intentId !== intent_id) {
    return res.status(404).json({ error: 'approval_interaction_not_found' });
  }
  if (interaction.provider !== providerName) {
    return res.status(409).json({ error: 'provider_mismatch', expected: interaction.provider, got: providerName });
  }
  if (![INTERACTION_STATES.PENDING, INTERACTION_STATES.SENT, INTERACTION_STATES.WAITING_INPUT].includes(interaction.state)) {
    return res.status(409).json({ error: 'interaction_not_pending', state: interaction.state });
  }

  const interactionError = guardApprovalInteraction(proposal);
  if (interactionError) return res.status(interactionError.httpStatus).json(interactionError.body);

  const expectedRespondsTo = proposal.message_id || proposal.id;
  if (responds_to !== undefined && responds_to !== expectedRespondsTo) {
    return res.status(409).json({ error: 'responds_to_mismatch', expected: expectedRespondsTo });
  }

  const currentHash = canonicalIntentHash(proposal);
  if (approved_intent_hash !== undefined && approved_intent_hash !== currentHash) {
    return res.status(409).json({ error: 'approved_intent_hash_mismatch' });
  }

  if (decided_at !== undefined) {
    const tsCheck = checkTimestampTolerance(decided_at);
    if (!tsCheck.valid) return res.status(409).json({ error: 'replay_rejected', reason: tsCheck.reason });
  }

  if (interaction.expiresAt && Date.now() > new Date(interaction.expiresAt).getTime()) {
    updateInteractionState(interaction.id, INTERACTION_STATES.EXPIRED);
    transitionApprovalState(intent_id, APPROVAL_STATES.EXPIRED, { actor: `provider:${providerName}`, reason: 'callback_after_expiry' });
    logEvent(intent_id, 'expired', 'system', {});
    return res.status(410).json({ error: 'interaction_expired' });
  }

  const suppliedFactors = evidence?.factors || [];
  const missingFactors = (interaction.requiredFactors || []).filter((f) => !suppliedFactors.includes(f));
  if (missingFactors.length) {
    return res.status(409).json({ error: 'insufficient_evidence_factors', missing: missingFactors, supplied: suppliedFactors });
  }

  const decisionUpper = String(decision).toUpperCase();
  if (!['APPROVE', 'DECLINE', 'REJECT'].includes(decisionUpper)) {
    return res.status(400).json({ error: 'invalid_decision', message: 'decision must be APPROVE, DECLINE, or REJECT' });
  }

  const factor = suppliedFactors[0] || `${providerName}.callback.v1`;
  const evidenceUpdate = updateInteractionState(interaction.id, INTERACTION_STATES.ANSWERED, {
    evidence: { decision: decisionUpper, factors: suppliedFactors, proof: evidence?.proof || null },
  });
  if (!evidenceUpdate.ok) {
    return res.status(409).json({ error: evidenceUpdate.reason, state: evidenceUpdate.previous });
  }

  const actor = `provider:${providerName}`;
  if (decisionUpper === 'APPROVE') {
    return res.json(executeApproveDecision(proposal, { actor, factor }));
  }
  return res.json(executeRejectDecision(proposal, { actor, reason: reason || `declined_via_${providerName}`, factor }));
});

module.exports = router;
module.exports.registerWebhook = registerWebhook;
module.exports.fireWebhook = fireWebhook;
module.exports.executeApproveDecision = executeApproveDecision;
module.exports.executeRejectDecision = executeRejectDecision;
module.exports.guardApprovalInteraction = guardApprovalInteraction;
