const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateDeliveryToken, hashPayload, parseExpiry } = require('../lib/crypto');
const { evaluatePolicy } = require('../lib/policy');
const { scoreRisk } = require('../lib/risk');
const { logEvent, getAuditTrail } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { RunLedger } = require('../lib/runs');
const { EVENT_TYPES } = require('../lib/runs/constants');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../data/payloads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// POST /v1/propose
router.post('/propose', authenticate, (req, res) => {
  const { payload, destination, policy, expiresIn, metadata, recordCount, on_behalf_of } = req.body;

  if (!destination || !policy) {
    return res.status(400).json({ error: 'destination and policy are required' });
  }

  const proposalId = generateId('int');
  const now = Date.now();
  const expirySeconds = parseExpiry(expiresIn || '1h');
  const expiresAt = now + (expirySeconds * 1000);

  // Determine payload type from path or content
  let payloadType = null;
  let payloadPath = null;
  let payloadHash = null;
  let payloadContent = null;

  if (payload) {
    const looksLikeFilePath = /\.(csv|json|txt|pdf|xml|xlsx|jsonl)$/i.test(payload.trim());

    if (looksLikeFilePath) {
      // File path — use extension for type, no content to term-scan
      payloadType = path.extname(payload.trim()).slice(1).toLowerCase();
      payloadPath = payload.trim();
      payloadContent = null;
    } else {
      // Text content (support reply, email body, JSON string, data: URI, etc.)
      payloadContent = payload;
      payloadHash = hashPayload(payload);
      payloadPath = path.join(UPLOAD_DIR, proposalId);
      fs.writeFileSync(payloadPath, payload);
      // Infer type from data: URI prefix if present
      if (payload.startsWith('data:application/json')) payloadType = 'json';
      else if (payload.startsWith('data:text/csv')) payloadType = 'csv';
    }
  }

  // Evaluate policy
  const result = evaluatePolicy(policy, {
    destination,
    payloadType,
    payloadContent,
    recordCount: recordCount ? parseInt(recordCount) : undefined,
    metadata,
    agentId: req.agent?.id
  });

  // Idempotency check — block duplicate intents
  const idempotencyKey = req.body.idempotency_key || null;
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id, status FROM proposals WHERE idempotency_key = ? AND sender_agent_id = ?').get(idempotencyKey, req.agent.id);
    if (existing) {
      return res.status(409).json({
        proposalId: existing.id,
        intentId: existing.id,
        status: 'duplicate_blocked',
        blockReason: `Duplicate intent — idempotency_key already used: ${idempotencyKey}`,
        existingStatus: existing.status
      });
    }
  }

  // Risk scoring
  const risk = scoreRisk({
    destination,
    recordCount: recordCount ? parseInt(recordCount) : 0,
    estimatedValueUsd: req.body.estimated_value_usd ? parseFloat(req.body.estimated_value_usd) : 0,
    sensitivityTags: req.body.sensitivity_tags || [],
    payloadContent,
    policyRequireApproval: null // evaluated in policy engine
  });

  // Store proposal
  db.prepare(`
    INSERT INTO proposals (id, sender_agent_id, payload_path, payload_hash, payload_type, destination, policy_id, status, block_reason, created_at, expires_at, on_behalf_of, idempotency_key, risk_score, risk_level, sensitivity_tags, estimated_records, estimated_value_usd, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    req.agent.id,
    payloadPath,
    payloadHash,
    payloadType,
    destination,
    policy,
    result.status,
    result.reason || null,
    now,
    expiresAt,
    on_behalf_of || null,
    idempotencyKey,
    risk.risk_score,
    risk.risk_level,
    JSON.stringify(req.body.sensitivity_tags || []),
    recordCount ? parseInt(recordCount) : null,
    req.body.estimated_value_usd ? parseFloat(req.body.estimated_value_usd) : null,
    req.body.action || destination
  );

  // Store policy decision
  const decisionId = generateId('dec');
  const reasonCode = result.status === 'blocked'
    ? (result.reason?.includes('threshold') ? 'record_threshold_exceeded'
      : result.reason?.includes('term') ? 'blocked_term_detected'
      : result.reason?.includes('destination') ? 'destination_not_allowed'
      : result.reason?.includes('sensitive') ? 'sensitive_data_detected'
      : 'manual_review_required')
    : result.status === 'approved' ? 'approved_by_policy'
    : 'manual_review_required';

  db.prepare(`
    INSERT INTO policy_decisions (id, intent_id, status, reason_code, reason_detail, risk_score, risk_level, policy_snapshot, required_approvals, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId, proposalId,
    result.status === 'approved' ? 'approved' : result.status === 'blocked' ? 'blocked' : 'pending_approval',
    reasonCode,
    result.reason || null,
    risk.risk_score,
    risk.risk_level,
    JSON.stringify({ policy, destination }),
    result.status === 'pending_approval' ? 1 : 0,
    now
  );

  // Log audit event
  logEvent(proposalId, 'proposed', req.agent.name, { destination, policy, on_behalf_of: on_behalf_of || null });
  logEvent(proposalId, 'policy_checked', 'system', { result: result.status, reason: result.reason });

  // Run Ledger integration (optional — only if runId provided)
  const runId = req.body.runId || null;
  if (runId) {
    const ledger = RunLedger.getRun(runId);
    if (ledger) {
      RunLedger.recordEvent({
        ledgerId: ledger.id,
        eventType: EVENT_TYPES.INTENT_PROPOSED,
        actorId: req.agent.id,
        payload: { intentId: proposalId, destination, policy, recordCount }
      });
      RunLedger.recordEvent({
        ledgerId: ledger.id,
        eventType: EVENT_TYPES.POLICY_CHECKED,
        actorId: 'gate',
        payload: { intentId: proposalId, decision: result.status, reason: result.reason }
      });
    }
  }

  if (result.status === 'blocked') {
    logEvent(proposalId, 'blocked', 'system', { reason: result.reason });
  } else if (result.status === 'approved') {
    logEvent(proposalId, 'approved', 'system', { policy, auto: true });
    
    // Run Ledger: auto-approval = approval_received
    if (runId) {
      const ledger = RunLedger.getRun(runId);
      if (ledger) {
        RunLedger.recordEvent({
          ledgerId: ledger.id,
          eventType: EVENT_TYPES.APPROVAL_RECEIVED,
          actorId: 'gate',
          payload: { intentId: proposalId, auto: true }
        });
      }
    }

    // gate_exec: auto-approved + vault credential → Gate executes immediately
    const { hasCredential } = require('../proxy/vault');
    const { executeIntent }  = require('../proxy/executor');
    if (hasCredential(destination) && process.env.PROXY_API_KEY) {
      const payloadContent = payloadPath && require('fs').existsSync(payloadPath)
        ? require('fs').readFileSync(payloadPath, 'utf8') : payload || null;
      setImmediate(async () => {
        try {
          const r = await executeIntent({ id: proposalId, destination, payloadContent });
          console.log(`[gate_exec] ${proposalId} auto-exec → ${r.succeeded ? 'succeeded' : 'failed'} (HTTP ${r.httpStatus})`);
        } catch (e) {
          console.error(`[gate_exec] Auto-exec error ${proposalId}:`, e.message);
        }
      });
    }
  }

  res.json({
    proposalId,
    intentId: proposalId,   // V2 alias
    status: result.status,
    blockReason: ['blocked','duplicate_blocked'].includes(result.status) ? result.reason : null,
    expiresAt: new Date(expiresAt).toISOString(),
    riskScore: risk.risk_score,
    riskLevel: risk.risk_level,
    riskFactors: risk.factors
  });
});

// GET /v1/proposals/:id
router.get('/proposals/:id', authenticate, (req, res) => {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const isReviewer = (req.agent?.role === 'admin' || req.agent?.role === 'reviewer');
  if (!isReviewer && proposal.sender_agent_id !== req.agent.id) {
    return res.status(403).json({ error: 'forbidden', message: 'Cannot access intents from other agents' });
  }

  const auditTrail = getAuditTrail(req.params.id);
  const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(req.params.id);

  res.json({
    ...proposal,
    created_at: new Date(proposal.created_at).toISOString(),
    expires_at: proposal.expires_at ? new Date(proposal.expires_at).toISOString() : null,
    manifest: manifest || null,
    auditTrail
  });
});

module.exports = router;
