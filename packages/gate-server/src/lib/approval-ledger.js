// Durable, provider-neutral approval interaction ledger (issue #12).
// One row per dispatched approval request, regardless of provider. This is
// additive to proposals.approval_state — that column stays the source of
// truth used to gate approve/reject/execute; the ledger exists so external
// approvals are auditable first-class objects instead of a side effect of a
// webhook that leaves no independent trail.

const db = require('./db');
const { generateId } = require('./crypto');

const INTERACTION_STATES = {
  PENDING: 'pending',
  SENT: 'sent',
  WAITING_INPUT: 'waiting_input',
  ANSWERED: 'answered',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

function createInteraction({
  intentId,
  provider,
  messageId,
  principalId = null,
  channelType = null,
  channelAddressRedacted = null,
  approvedIntentHash = null,
  requiredFactors = [],
  assuranceLevel = null,
  expiresAt = null,
}) {
  const id = generateId('gai');
  const now = Date.now();
  db.prepare(`
    INSERT INTO approval_interactions
      (id, intent_id, provider, provider_interaction_id, message_id, state, principal_id, channel_type, channel_address_redacted, approved_intent_hash, required_factors_json, assurance_level, evidence_json, created_at, expires_at, answered_at)
    VALUES (@id, @intent_id, @provider, NULL, @message_id, @state, @principal_id, @channel_type, @channel_address_redacted, @approved_intent_hash, @required_factors_json, @assurance_level, NULL, @created_at, @expires_at, NULL)
  `).run({
    id,
    intent_id: intentId,
    provider,
    message_id: messageId,
    state: INTERACTION_STATES.PENDING,
    principal_id: principalId,
    channel_type: channelType,
    channel_address_redacted: channelAddressRedacted,
    approved_intent_hash: approvedIntentHash,
    required_factors_json: JSON.stringify(requiredFactors || []),
    assurance_level: assuranceLevel,
    created_at: now,
    expires_at: expiresAt,
  });
  return getInteraction(id);
}

function getInteraction(id) {
  const row = db.prepare('SELECT * FROM approval_interactions WHERE id = ?').get(id);
  return row ? formatInteraction(row) : null;
}

function getInteractionByMessageId(messageId) {
  const row = db.prepare('SELECT * FROM approval_interactions WHERE message_id = ?').get(messageId);
  return row ? formatInteraction(row) : null;
}

// Most recent interaction for an intent — an intent may be re-dispatched
// (e.g. a future retry/escalation path), so this is "latest", not "only".
function getLatestInteractionForIntent(intentId) {
  const row = db.prepare('SELECT * FROM approval_interactions WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1').get(intentId);
  return row ? formatInteraction(row) : null;
}

function listInteractionsForIntent(intentId) {
  return db.prepare('SELECT * FROM approval_interactions WHERE intent_id = ? ORDER BY created_at ASC').all(intentId).map(formatInteraction);
}

function setProviderInteractionId(id, providerInteractionId) {
  db.prepare('UPDATE approval_interactions SET provider_interaction_id = ? WHERE id = ?').run(providerInteractionId, id);
}

// Mirrors the allow-listed transition table in approval-lifecycle.js so the
// ledger and proposals.approval_state can never drift into inconsistent
// states relative to each other.
const TERMINAL_STATES = new Set([
  INTERACTION_STATES.ANSWERED,
  INTERACTION_STATES.EXPIRED,
  INTERACTION_STATES.CANCELLED,
  INTERACTION_STATES.FAILED,
]);

function updateInteractionState(id, nextState, { evidence } = {}) {
  const row = db.prepare('SELECT * FROM approval_interactions WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'interaction_not_found' };
  if (TERMINAL_STATES.has(row.state) && row.state !== nextState) {
    return { ok: false, reason: 'interaction_terminal', previous: row.state };
  }

  const answeredAt = TERMINAL_STATES.has(nextState) ? Date.now() : row.answered_at;
  db.prepare('UPDATE approval_interactions SET state = ?, evidence_json = COALESCE(?, evidence_json), answered_at = ? WHERE id = ?')
    .run(nextState, evidence ? JSON.stringify(evidence) : null, answeredAt, id);
  return { ok: true, previous: row.state, next: nextState };
}

function formatInteraction(row) {
  return {
    id: row.id,
    intentId: row.intent_id,
    provider: row.provider,
    providerInteractionId: row.provider_interaction_id,
    messageId: row.message_id,
    state: row.state,
    principalId: row.principal_id,
    channelType: row.channel_type,
    channelAddressRedacted: row.channel_address_redacted,
    approvedIntentHash: row.approved_intent_hash,
    requiredFactors: JSON.parse(row.required_factors_json || '[]'),
    assuranceLevel: row.assurance_level,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    answeredAt: row.answered_at ? new Date(row.answered_at).toISOString() : null,
  };
}

module.exports = {
  INTERACTION_STATES,
  createInteraction,
  getInteraction,
  getInteractionByMessageId,
  getLatestInteractionForIntent,
  listInteractionsForIntent,
  setProviderInteractionId,
  updateInteractionState,
};
