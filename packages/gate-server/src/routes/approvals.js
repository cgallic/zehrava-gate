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
const { buildApprovalEvidence } = require('../lib/evidence');
const { consumeNonce, checkTimestampTolerance } = require('../lib/replay');

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

// ── WEBHOOK SYSTEM (DB-backed, survives restarts) ─────────────────────────

function registerWebhook(intentId, url, secret) {
  const existing = db.prepare('SELECT id FROM webhooks WHERE intent_id = ? AND fired = 0').get(intentId);
  if (existing) {
    // Update URL/secret if re-registered
    db.prepare('UPDATE webhooks SET url = ?, secret = ? WHERE id = ?')
      .run(url, secret || null, existing.id);
    return existing.id;
  }
  const id = generateId('whk');
  db.prepare('INSERT INTO webhooks (id, intent_id, url, secret, fired, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, intentId, url, secret || null, Date.now());
  return id;
}

async function fireWebhook(intentId, event, data) {
  const hook = db.prepare('SELECT * FROM webhooks WHERE intent_id = ? AND fired = 0').get(intentId);
  if (!hook) return;

  try {
    const payload = JSON.stringify({
      intentId,
      event,
      actor: data.approver || data.rejector || 'system',
      firedAt: new Date().toISOString(),
      ...data
    });

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const { URL } = await import('url');
    const u = new URL(hook.url);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(hook.secret ? { 'X-Gate-Secret': hook.secret } : {})
      }
    });
    req.on('error', (e) => console.error(`[gate] webhook HTTP error for ${intentId}:`, e.message));
    req.write(payload);
    req.end();

    // Mark fired in DB
    db.prepare('UPDATE webhooks SET fired = 1, fired_at = ? WHERE id = ?')
      .run(Date.now(), hook.id);

    console.log(`[gate] webhook fired: ${intentId} → ${event} → ${hook.url}`);
  } catch (e) {
    console.error(`[gate] webhook failed for ${intentId}:`, e.message);
  }
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
function executeApproveDecision(proposal, { actor, factor = 'manual.dashboard.v1' }) {
  const proposalId = proposal.id;
  const deliveryToken = generateDeliveryToken();
  db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);
  db.prepare(`
    INSERT INTO manifests (id, proposal_id, signed_by, delivery_token)
    VALUES (?, ?, ?, ?)
  `).run(generateId('mfst'), proposalId, actor, deliveryToken);

  transitionApprovalState(proposalId, APPROVAL_STATES.ANSWERED, { actor, reason: 'approved' });
  const freshProposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  const evidence = buildApprovalEvidence(freshProposal, { decision: 'APPROVE', factor, actor });

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
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposalId);
    transitionApprovalState(proposalId, APPROVAL_STATES.EXPIRED, { actor: 'system', reason: 'ttl_elapsed' });
    logEvent(proposalId, 'expired', 'system', {});
    return res.status(410).json({ error: 'Proposal has expired' });
  }

  res.json(executeApproveDecision(proposal, { actor: req.agent.name }));
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
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposal.id);
    transitionApprovalState(proposal.id, APPROVAL_STATES.EXPIRED, { actor: 'system', reason: 'ttl_elapsed' });
    logEvent(proposal.id, 'expired', 'system', {});
    return res.status(410).json({ error: 'Proposal has expired' });
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

module.exports = router;
module.exports.registerWebhook = registerWebhook;
module.exports.fireWebhook = fireWebhook;
