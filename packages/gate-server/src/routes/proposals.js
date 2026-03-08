const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateDeliveryToken, hashPayload, parseExpiry } = require('../lib/crypto');
const { evaluatePolicy } = require('../lib/policy');
const { logEvent, getAuditTrail } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../data/payloads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// POST /v1/propose
router.post('/propose', authenticate, (req, res) => {
  const { payload, destination, policy, expiresIn, metadata, recordCount, on_behalf_of } = req.body;

  if (!destination || !policy) {
    return res.status(400).json({ error: 'destination and policy are required' });
  }

  const proposalId = generateId('prop');
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
    metadata
  });

  // Store proposal
  db.prepare(`
    INSERT INTO proposals (id, sender_agent_id, payload_path, payload_hash, payload_type, destination, policy_id, status, block_reason, created_at, expires_at, on_behalf_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    on_behalf_of || null
  );

  // Log audit event
  logEvent(proposalId, 'proposed', req.agent.name, { destination, policy, on_behalf_of: on_behalf_of || null });
  logEvent(proposalId, 'policy_checked', 'system', { result: result.status, reason: result.reason });

  if (result.status === 'blocked') {
    logEvent(proposalId, 'blocked', 'system', { reason: result.reason });
  } else if (result.status === 'approved') {
    logEvent(proposalId, 'auto_approved', 'system', { policy });
  }

  res.json({
    proposalId,
    status: result.status,
    blockReason: result.status === 'blocked' ? result.reason : null,
    expiresAt: new Date(expiresAt).toISOString()
  });
});

// GET /v1/proposals/:id
router.get('/proposals/:id', authenticate, (req, res) => {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

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
