// A2H Layer 2 (draft) — authority & policy messages, mapped onto Gate's
// authority model (lib/authority.js). The wire format is Zehrava's proposal
// for the part of A2H that v1.0 defers to "Layer 2" (standing policies,
// revocation, delegation); see docs/a2h-layer2-proposal.md.
//
// Every message is fail-closed: a condition Gate cannot enforce exactly is
// rejected with ERR.UNSUPPORTED_CONDITION rather than silently dropped,
// because a dropped condition would widen the authority the principal
// actually granted.

const db = require('./db');
const { checkTimestampTolerance } = require('./replay');
const {
  createStandingApproval, revokeStandingApproval, getStandingApproval,
  createDelegation, revokeDelegation, getDelegation,
} = require('./authority');

const LAYER2_DRAFT = 'zehrava-a2h-l2-draft-01';
const LAYER2_TYPES = ['POLICY', 'REVOKE', 'DELEGATE'];
const DAY_SEC = 86400;

db.exec(`
  CREATE TABLE IF NOT EXISTS a2h_layer2_messages (
    message_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    principal_id TEXT,
    evidence_json TEXT,
    result_json TEXT NOT NULL,
    received_by TEXT,
    received_at INTEGER NOT NULL
  );
`);

class Layer2Error extends Error {
  constructor(httpStatus, code, message, extra = {}) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.extra = extra;
  }
}

function errorBody(messageId, err) {
  return {
    a2h_version: '1.2',
    type: 'ERROR',
    responds_to: messageId || null,
    error: { code: err.code, message: err.message, ...err.extra },
    timestamp: new Date().toISOString(),
  };
}

function resultBody(messageId, result, duplicate = false) {
  const body = { a2h_version: '1.2', type: 'RESULT', responds_to: messageId, status: 'APPLIED', result };
  if (duplicate) body.duplicate = true;
  return body;
}

// { value, currency } → USD number. Only USD is enforceable today.
function usdAmount(amount, field) {
  if (!amount || typeof amount !== 'object' || typeof amount.value !== 'number' || !Number.isFinite(amount.value) || amount.value < 0) {
    throw new Layer2Error(400, 'ERR.INVALID_REQUEST', `${field} must be { value: <non-negative number>, currency: "USD" }`);
  }
  if (String(amount.currency || '').toUpperCase() !== 'USD') {
    throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', `${field}.currency ${amount.currency || '(missing)'} is not enforceable; only USD`, { condition: field });
  }
  return amount.value;
}

function parseExpiry(expiresAt, { required }) {
  if (!expiresAt) {
    if (required) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'expires_at is required — standing authority must have a lifetime');
    return null;
  }
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'expires_at must be an ISO 8601 timestamp');
  if (ts <= Date.now()) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'expires_at is in the past');
  return ts;
}

// Granting standing authority is at least as consequential as a single
// AUTHORIZE, so it must carry the principal's consent evidence.
function requireConsentEvidence(message) {
  if (!message.evidence?.factor) {
    throw new Layer2Error(400, 'ERR.INVALID_REQUEST', `${message.type} must carry the principal's consent evidence ({ factor, proof })`);
  }
}

function rejectUnknownKeys(obj, allowed, field) {
  const unknown = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', `${field} has conditions this enforcer cannot evaluate: ${unknown.join(', ')}`, { conditions: unknown });
  }
}

// POLICY { effect: AUTO_APPROVE, action_class, conditions, expires_at } →
// a Gate standing approval scoped to the message's principal.
function applyPolicy(message, actor) {
  requireConsentEvidence(message);
  const policy = message.policy;
  if (!policy || typeof policy !== 'object') throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'policy object is required');
  if (!message.principal_id) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'principal_id is required — a standing policy is always granted by a principal');
  rejectUnknownKeys(policy, ['effect', 'action_class', 'conditions', 'expires_at', 'label'], 'policy');
  if (policy.effect !== 'AUTO_APPROVE') {
    throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', `policy.effect ${policy.effect || '(missing)'} is not supported; POLICY grants AUTO_APPROVE (use SCOPE for deny/require-authorize boundaries)`, { condition: 'effect' });
  }
  if (!policy.action_class || typeof policy.action_class !== 'string') {
    throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'policy.action_class is required (e.g. "stripe.refund")');
  }

  const conditions = policy.conditions || {};
  rejectUnknownKeys(conditions, ['max_amount', 'window_limits'], 'policy.conditions');
  const maxAmountUsd = conditions.max_amount !== undefined ? usdAmount(conditions.max_amount, 'policy.conditions.max_amount') : null;

  let dailyLimitUsd = null;
  if (conditions.window_limits !== undefined) {
    if (!Array.isArray(conditions.window_limits) || conditions.window_limits.length !== 1) {
      throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', 'exactly one window_limits entry (period_sec: 86400) is enforceable today', { condition: 'window_limits' });
    }
    const [window] = conditions.window_limits;
    if (window.period_sec !== DAY_SEC) {
      throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', `window period_sec ${window.period_sec} is not enforceable; only 86400 (rolling 24h)`, { condition: 'window_limits.period_sec' });
    }
    rejectUnknownKeys(window, ['period_sec', 'max_total'], 'policy.conditions.window_limits[0]');
    dailyLimitUsd = usdAmount(window.max_total, 'policy.conditions.window_limits[0].max_total');
  }

  if (maxAmountUsd === null && dailyLimitUsd === null) {
    throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'an AUTO_APPROVE policy needs at least one bound: max_amount or window_limits');
  }

  const standing = createStandingApproval({
    destination: policy.action_class,
    principalId: message.principal_id,
    maxAmountUsd,
    dailyLimitUsd,
    expiresAt: parseExpiry(policy.expires_at, { required: true }),
    createdBy: actor,
  });
  return { kind: 'POLICY', policy_id: standing.id, state: 'ACTIVE', standing_approval: standing };
}

// DELEGATE → a Gate delegation: `delegate_id` (a Gate approver identity)
// may answer AUTHORIZE requests on the delegator's behalf, within bounds.
function applyDelegate(message, actor) {
  requireConsentEvidence(message);
  const d = message.delegation;
  if (!d || typeof d !== 'object') throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'delegation object is required');
  rejectUnknownKeys(d, ['delegator_principal_id', 'delegate_id', 'action_class', 'conditions', 'expires_at', 'label'], 'delegation');
  const delegator = d.delegator_principal_id || message.principal_id;
  if (!delegator) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'delegation.delegator_principal_id (or principal_id) is required');
  if (message.principal_id && d.delegator_principal_id && d.delegator_principal_id !== message.principal_id) {
    throw new Layer2Error(403, 'ERR.INVALID_PRINCIPAL', 'a principal can only delegate their own authority');
  }
  if (!d.delegate_id) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'delegation.delegate_id is required');
  const conditions = d.conditions || {};
  rejectUnknownKeys(conditions, ['max_amount'], 'delegation.conditions');
  const maxAmountUsd = conditions.max_amount !== undefined ? usdAmount(conditions.max_amount, 'delegation.conditions.max_amount') : null;

  const delegation = createDelegation({
    delegatorPrincipalId: delegator,
    delegateAgentId: d.delegate_id,
    destination: d.action_class || null,
    maxAmountUsd,
    expiresAt: parseExpiry(d.expires_at, { required: true }),
    createdBy: actor,
  });
  return { kind: 'DELEGATE', delegation_id: delegation.id, state: 'ACTIVE', delegation };
}

// REVOKE { target: { type: POLICY | DELEGATION, id } } — prospective and
// immediate: Gate evaluates standing authority at decision time, so the
// next intent after this returns can no longer use it.
function applyRevoke(message) {
  const target = message.target;
  if (!target?.type || !target?.id) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'target { type, id } is required');
  const type = String(target.type).toUpperCase();
  let lookup;
  let revoke;
  if (type === 'POLICY') { lookup = getStandingApproval; revoke = revokeStandingApproval; }
  else if (type === 'DELEGATION') { lookup = getDelegation; revoke = revokeDelegation; }
  else {
    throw new Layer2Error(422, 'ERR.UNSUPPORTED_CONDITION', `REVOKE target.type ${target.type} is not supported here; cancel a pending interaction with POST /v1/intents/:id/cancel-approval`, { condition: 'target.type' });
  }

  const existing = lookup(target.id);
  if (!existing) throw new Layer2Error(404, 'ERR.INVALID_REQUEST', `${type} ${target.id} not found`);
  const owner = type === 'POLICY' ? existing.principalId : existing.delegatorPrincipalId;
  if (message.principal_id && owner && owner !== message.principal_id) {
    throw new Layer2Error(403, 'ERR.INVALID_PRINCIPAL', 'a principal can only revoke authority they granted');
  }
  const result = revoke(target.id, message.reason || null);
  if (!result.ok) throw new Layer2Error(409, 'ERR.CONFLICT', `${type} ${target.id} is already revoked`);
  return { kind: 'REVOKE', target: { type, id: target.id }, state: 'REVOKED' };
}

function handleLayer2Message(message, { actor }) {
  const messageId = message?.message_id || null;
  try {
    if (!message || typeof message !== 'object') throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'JSON body required');
    if (!messageId) throw new Layer2Error(400, 'ERR.INVALID_REQUEST', 'message_id is required');
    const type = String(message.type || '').toUpperCase();
    if (!LAYER2_TYPES.includes(type)) {
      throw new Layer2Error(400, 'ERR.INVALID_REQUEST', `type must be one of ${LAYER2_TYPES.join(', ')}`);
    }

    // Idempotency on message_id (A2H §1.10.2): a replayed message returns
    // the original outcome instead of granting authority twice.
    const seen = db.prepare('SELECT * FROM a2h_layer2_messages WHERE message_id = ?').get(messageId);
    if (seen) return { httpStatus: 200, body: resultBody(messageId, JSON.parse(seen.result_json), true) };

    if (message.created_at !== undefined) {
      const ts = checkTimestampTolerance(message.created_at);
      if (!ts.valid) throw new Layer2Error(409, 'ERR.REPLAY_REJECTED', `created_at rejected: ${ts.reason}`);
    }

    const result = type === 'POLICY' ? applyPolicy({ ...message, type }, actor)
      : type === 'DELEGATE' ? applyDelegate({ ...message, type }, actor)
        : applyRevoke({ ...message, type });

    db.prepare(`
      INSERT INTO a2h_layer2_messages (message_id, type, principal_id, evidence_json, result_json, received_by, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, type, message.principal_id || null, message.evidence ? JSON.stringify(message.evidence) : null, JSON.stringify(result), actor, Date.now());

    return { httpStatus: type === 'REVOKE' ? 200 : 201, body: resultBody(messageId, result), type, result };
  } catch (err) {
    if (err instanceof Layer2Error) return { httpStatus: err.httpStatus, body: errorBody(messageId, err) };
    throw err;
  }
}

module.exports = { LAYER2_DRAFT, LAYER2_TYPES, handleLayer2Message };
