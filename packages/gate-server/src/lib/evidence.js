const db = require('./db');
const { generateId } = require('./crypto');
const { canonicalize, sha256Hex, signDetached, verifyDetached } = require('./signing');

// Canonical payload used to bind an approval decision to the exact intent
// that was approved. Anything here changing between approval and execution
// means the executed action is not the one a human actually approved.
function canonicalIntentPayload(proposal) {
  return {
    intent_id: proposal.id,
    message_id: proposal.message_id || null,
    destination: proposal.destination,
    action: proposal.action || proposal.destination,
    policy_id: proposal.policy_id,
    payload_hash: proposal.payload_hash || null,
    estimated_value_usd: proposal.estimated_value_usd ?? null,
    sensitivity_tags: (() => {
      try { return JSON.parse(proposal.sensitivity_tags || '[]'); } catch { return []; }
    })(),
  };
}

function canonicalIntentHash(proposal) {
  return sha256Hex(canonicalize(canonicalIntentPayload(proposal)));
}

/**
 * Build and persist an A2H-shaped approval evidence bundle for a decided intent.
 * decision: 'APPROVE' | 'REJECT'
 */
function buildApprovalEvidence(proposal, { decision, factor = 'manual.dashboard.v1', actor, interactionId }) {
  const decidedAt = Date.now();
  const approvedIntentHash = canonicalIntentHash(proposal);
  const respondsTo = proposal.message_id || proposal.id;
  const finalInteractionId = interactionId || require('./crypto').generateInteractionId();

  const responsePayload = {
    protocol: 'a2h.v1',
    interaction_id: finalInteractionId,
    responds_to: respondsTo,
    decision,
    decided_at: decidedAt,
    factor,
    approved_intent_hash: approvedIntentHash,
  };
  const responseJws = signDetached(responsePayload);

  const evidence = {
    id: generateId('evd'),
    intent_id: proposal.id,
    protocol: 'a2h.v1',
    interaction_id: finalInteractionId,
    request_jws: null,
    response_jws: responseJws,
    responds_to: respondsTo,
    decision,
    decided_at: decidedAt,
    factor,
    proof_json: JSON.stringify({ actor: actor || 'system' }),
    approved_intent_hash: approvedIntentHash,
    created_at: decidedAt,
  };

  db.prepare(`
    INSERT INTO approval_evidence (id, intent_id, protocol, interaction_id, request_jws, response_jws, responds_to, decision, decided_at, factor, proof_json, approved_intent_hash, created_at)
    VALUES (@id, @intent_id, @protocol, @interaction_id, @request_jws, @response_jws, @responds_to, @decision, @decided_at, @factor, @proof_json, @approved_intent_hash, @created_at)
    ON CONFLICT(intent_id) DO UPDATE SET
      interaction_id = excluded.interaction_id,
      request_jws = excluded.request_jws,
      response_jws = excluded.response_jws,
      responds_to = excluded.responds_to,
      decision = excluded.decision,
      decided_at = excluded.decided_at,
      factor = excluded.factor,
      proof_json = excluded.proof_json,
      approved_intent_hash = excluded.approved_intent_hash,
      consumed_at = NULL,
      created_at = excluded.created_at
  `).run(evidence);

  return getApprovalEvidence(proposal.id);
}

function getApprovalEvidence(intentId) {
  const row = db.prepare('SELECT * FROM approval_evidence WHERE intent_id = ?').get(intentId);
  if (!row) return null;
  return formatEvidence(row);
}

function formatEvidence(row) {
  return {
    protocol: row.protocol,
    interaction_id: row.interaction_id,
    request_jws: row.request_jws,
    response_jws: row.response_jws,
    responds_to: row.responds_to,
    decision: row.decision,
    decided_at: new Date(row.decided_at).toISOString(),
    factor: row.factor,
    proof: JSON.parse(row.proof_json || '{}'),
    approved_intent_hash: row.approved_intent_hash,
    consumed_at: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
  };
}

/**
 * Verify that stored evidence still binds to the CURRENT canonical state of
 * the intent. Fails closed: any mismatch, missing signature, or expiry
 * returns { valid: false, reason }. If no evidence was ever recorded for
 * this intent (legacy data, or approvals made before this feature existed),
 * verification is skipped rather than blocking execution.
 */
function verifyApprovalEvidence(proposal) {
  const row = db.prepare('SELECT * FROM approval_evidence WHERE intent_id = ?').get(proposal.id);
  if (!row) return { valid: true, skipped: true, reason: 'no_evidence_recorded' };

  if (row.decision !== 'APPROVE') {
    return { valid: false, reason: 'evidence_decision_not_approve' };
  }
  if (row.responds_to !== (proposal.message_id || proposal.id)) {
    return { valid: false, reason: 'responds_to_mismatch' };
  }

  const currentHash = canonicalIntentHash(proposal);
  if (row.approved_intent_hash !== currentHash) {
    return { valid: false, reason: 'approved_intent_hash_mismatch' };
  }

  const responsePayload = {
    protocol: row.protocol,
    interaction_id: row.interaction_id,
    responds_to: row.responds_to,
    decision: row.decision,
    decided_at: row.decided_at,
    factor: row.factor,
    approved_intent_hash: row.approved_intent_hash,
  };
  if (!verifyDetached(row.response_jws, responsePayload)) {
    return { valid: false, reason: 'signature_invalid' };
  }

  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    return { valid: false, reason: 'evidence_expired' };
  }

  return { valid: true, skipped: false };
}

function consumeApprovalEvidence(intentId) {
  db.prepare('UPDATE approval_evidence SET consumed_at = ? WHERE intent_id = ? AND consumed_at IS NULL')
    .run(Date.now(), intentId);
}

module.exports = {
  canonicalIntentPayload,
  canonicalIntentHash,
  buildApprovalEvidence,
  getApprovalEvidence,
  verifyApprovalEvidence,
  consumeApprovalEvidence,
};
