const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateExecutionToken } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { RunLedger } = require('../lib/runs');
const { EVENT_TYPES, SIDE_EFFECT_CLASS } = require('../lib/runs/constants');
const { sideEffectKey } = require('../lib/runs/hash');
const { verifyApprovalEvidence, consumeApprovalEvidence, canonicalIntentHash } = require('../lib/evidence');
const { signDetached, verifyDetached } = require('../lib/signing');

// Who may request, or report on, an intent's execution: the agent that
// proposed it, or a reviewer/admin. Any other registered agent is refused —
// an API key alone is not authority over someone else's intent.
function canActOnIntent(agent, intent) {
  if (!agent || !intent) return false;
  if (agent.role === 'admin' || agent.role === 'reviewer') return true;
  // Gate's own gate_exec executor (the proxy identity) runs vault-backed
  // intents for whoever proposed them.
  if (process.env.PROXY_API_KEY && agent.api_key_hash && agent.api_key_hash === require('../lib/crypto').hashApiKey(process.env.PROXY_API_KEY)) return true;
  return !!intent.sender_agent_id && agent.id === intent.sender_agent_id;
}

// The execution order Gate signs: everything a worker needs to check that
// what it is about to run is exactly what was approved.
function executionOrderPayload(e) {
  return {
    v: 1,
    execution_id: e.id,
    intent_id: e.intent_id,
    approved_intent_hash: e.approved_intent_hash || null,
    payload_hash: e.payload_hash || null,
    destination: e.destination,
    action: e.action || e.destination,
    mode: e.mode,
    issued_at: new Date(e.issued_at).toISOString(),
    expires_at: new Date(e.expires_at).toISOString(),
  };
}

// POST /v1/intents/:id/execute — issue execution order
router.post('/intents/:id/execute', authenticate, (req, res) => {
  const intent = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!intent) return res.status(404).json({ error: 'Intent not found' });
  if (!canActOnIntent(req.agent, intent)) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the proposing agent or a reviewer can request execution of this intent' });
  }

  // Check expiry
  if (intent.expires_at && Date.now() > intent.expires_at) {
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('expired', intent.id);
    return res.status(410).json({ error: 'Intent expired', status: 'expired' });
  }

  if (intent.status !== 'approved') {
    return res.status(409).json({
      error: `Intent cannot be executed — current status: ${intent.status}`,
      status: intent.status,
      hint: intent.status === 'pending_approval' ? 'Approve the intent first at /v1/intents/:id/approve' : undefined
    });
  }

  // Check if execution already exists
  const existing = db.prepare('SELECT * FROM executions WHERE intent_id = ?').get(intent.id);
  if (existing && existing.status === 'scheduled') {
    return res.json(formatExecution(existing, { includeToken: true }));
  }
  if (existing && ['executing','succeeded'].includes(existing.status)) {
    return res.status(409).json({ error: `Execution already ${existing.status}`, execution_id: existing.id, status: existing.status });
  }

  // Fail closed: if approval evidence was recorded for this intent, it must
  // still bind to the intent's exact current canonical state. This is what
  // stops "approve X, execute Y" — any drift between what was approved and
  // what's about to run blocks execution order issuance.
  const evidenceCheck = verifyApprovalEvidence(intent);
  if (!evidenceCheck.valid) {
    logEvent(intent.id, 'evidence_verification_failed', 'system', { reason: evidenceCheck.reason });
    return res.status(409).json({
      error: 'approval_evidence_invalid',
      reason: evidenceCheck.reason,
      message: 'Approval evidence does not bind to the current intent — execution order refused'
    });
  }

  const mode = req.body.mode || 'runner_exec';
  const executionId = generateId('exe');
  const executionToken = generateExecutionToken();
  const now = Date.now();
  const expiresAt = now + (15 * 60 * 1000); // 15 min

  const approvedIntentHash = canonicalIntentHash(intent);
  const orderJws = signDetached(executionOrderPayload({
    id: executionId, intent_id: intent.id, approved_intent_hash: approvedIntentHash,
    payload_hash: intent.payload_hash || null, destination: intent.destination,
    action: intent.action || intent.destination, mode, issued_at: now, expires_at: expiresAt,
  }));

  db.prepare(`
    INSERT INTO executions (id, intent_id, mode, destination, action, payload_ref, payload_hash, execution_token, status, issued_at, expires_at, approved_intent_hash, order_jws)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
  `).run(
    executionId, intent.id, mode,
    intent.destination,
    intent.action || intent.destination,
    intent.payload_path || null,
    intent.payload_hash || null,
    executionToken,
    now, expiresAt,
    approvedIntentHash,
    orderJws
  );

  // Update intent status to scheduled
  db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('scheduled', intent.id);
  if (!evidenceCheck.skipped) consumeApprovalEvidence(intent.id);
  logEvent(intent.id, 'execution_requested', req.agent?.name || 'system', { executionId, mode });

  // Run Ledger integration (find run by on_behalf_of agent if present)
  if (intent.on_behalf_of) {
    const runs = db.prepare('SELECT * FROM run_ledgers WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
      .all(intent.on_behalf_of, 'active');
    if (runs.length > 0) {
      RunLedger.recordEvent({
        ledgerId: runs[0].id,
        eventType: EVENT_TYPES.EXECUTION_REQUESTED,
        actorId: req.agent?.id || 'system',
        payload: { executionId, intentId: intent.id, mode }
      });
    }
  }

  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId);
  res.status(201).json(formatExecution(execution, { includeToken: true }));
});

// POST /v1/execution-orders/verify — a worker checks, before running
// anything, that the order it holds was issued by Gate and unaltered.
// Body: { execution_order, order_signature }
router.post('/execution-orders/verify', authenticate, (req, res) => {
  const { execution_order: order, order_signature: signature } = req.body || {};
  if (!order || !signature) return res.status(400).json({ error: 'execution_order and order_signature are required' });
  const signatureValid = verifyDetached(signature, order);
  const execution = order.execution_id ? db.prepare('SELECT * FROM executions WHERE id = ?').get(order.execution_id) : null;
  const matchesRecord = !!execution && execution.order_jws === signature;
  res.json({
    valid: signatureValid && matchesRecord,
    signature_valid: signatureValid,
    matches_issued_order: matchesRecord,
    status: execution?.status || null,
    expired: execution ? Date.now() > execution.expires_at : null,
  });
});

// GET /v1/executions/:id
router.get('/executions/:id', authenticate, (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });
  res.json(formatExecution(execution));
});

// POST /v1/executions/:id/report — worker reports result
// Worker auth: Bearer <execution_token>
router.post('/executions/:id/report', (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });

  // Auth: the execution token (Bearer header, or `execution_token` in the
  // body as gate_exec sends it), or the API key of an agent entitled to act
  // on this intent (its proposer or a reviewer).
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const presentedToken = [bearer, req.body?.execution_token].find((t) => t && t === execution.execution_token);
  const isValidToken = !!presentedToken;

  let isValidApiKey = false;
  if (!isValidToken && bearer) {
    const agent = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?')
      .get(require('../lib/crypto').hashApiKey(bearer));
    if (agent) {
      agent.role = agent.role || 'agent';
      const intentRow = db.prepare('SELECT * FROM proposals WHERE id = ?').get(execution.intent_id);
      if (!canActOnIntent(agent, intentRow)) {
        return res.status(403).json({ error: 'forbidden', message: 'Only the execution token holder, the proposing agent or a reviewer can report this execution' });
      }
      isValidApiKey = true;
    }
  }

  if (!isValidToken && !isValidApiKey) {
    return res.status(401).json({ error: 'Invalid execution token or API key' });
  }

  // An outcome is reported once. A succeeded/failed execution can't be
  // rewritten afterwards.
  if (execution.status !== 'scheduled') {
    return res.status(409).json({ error: 'execution_already_reported', status: execution.status });
  }

  // Check token expiry
  if (execution.expires_at && Date.now() > execution.expires_at && execution.status === 'scheduled') {
    db.prepare('UPDATE executions SET status = ? WHERE id = ?').run('expired', execution.id);
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('failed', execution.intent_id);
    return res.status(410).json({ error: 'Execution token expired' });
  }

  const { status, result, executed_at } = req.body;
  if (!['succeeded', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be succeeded or failed' });
  }

  const executedAt = executed_at ? new Date(executed_at).getTime() : Date.now();
  db.prepare(`
    UPDATE executions SET status = ?, executed_at = ?, result = ? WHERE id = ?
  `).run(status, executedAt, result ? JSON.stringify(result) : null, execution.id);

  const intentStatus = status === 'succeeded' ? 'succeeded' : 'failed';
  db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(intentStatus, execution.intent_id);

  const eventType = status === 'succeeded' ? 'execution_succeeded' : 'execution_failed';
  logEvent(execution.intent_id, eventType, 'runner', { executionId: execution.id, result });

  // Run Ledger integration (find run by on_behalf_of agent if present)
  const intent = db.prepare('SELECT * FROM proposals WHERE id = ?').get(execution.intent_id);
  if (intent && intent.on_behalf_of) {
    const runs = db.prepare('SELECT * FROM run_ledgers WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
      .all(intent.on_behalf_of, 'active');
    if (runs.length > 0) {
      const sideEffectCls = status === 'succeeded' ? SIDE_EFFECT_CLASS.EXTERNAL_MUTATION : SIDE_EFFECT_CLASS.NONE;
      const sideEffKey = status === 'succeeded' 
        ? sideEffectKey(execution.action, execution.destination, { executionId: execution.id })
        : null;
      
      RunLedger.recordEvent({
        ledgerId: runs[0].id,
        eventType: status === 'succeeded' ? EVENT_TYPES.EXECUTION_SUCCEEDED : EVENT_TYPES.RUN_FAILED,
        actorId: 'runner',
        payload: { executionId: execution.id, intentId: execution.intent_id, result },
        sideEffectClass: sideEffectCls,
        sideEffectKey: sideEffKey
      });
    }
  }

  const updated = db.prepare('SELECT * FROM executions WHERE id = ?').get(execution.id);
  res.json(formatExecution(updated));
});

// The one-time execution token is only ever returned to the caller that
// requested the execution (includeToken) — never on reads or reports.
function formatExecution(e, { includeToken = false } = {}) {
  const { getApprovalEvidence } = require('../lib/evidence');
  return {
    executionId: e.id,
    execution_id: e.id,
    intent_id: e.intent_id,
    mode: e.mode,
    destination: e.destination,
    action: e.action,
    payload_ref: e.payload_ref,
    payload_hash: e.payload_hash,
    execution_token: includeToken ? e.execution_token : undefined,
    execution_order: e.order_jws ? executionOrderPayload(e) : null,
    order_signature: e.order_jws || null,
    retry_policy: e.retry_policy ? JSON.parse(e.retry_policy) : { max_attempts: 3, backoff_seconds: 30 },
    status: e.status,
    issued_at: new Date(e.issued_at).toISOString(),
    expires_at: new Date(e.expires_at).toISOString(),
    executed_at: e.executed_at ? new Date(e.executed_at).toISOString() : null,
    result: e.result ? JSON.parse(e.result) : null,
    approval_evidence: getApprovalEvidence(e.intent_id)
  };
}

module.exports = router;
