const db = require('./db');
const { generateId, generateNonce } = require('./crypto');

const DEFAULT_NONCE_TTL_SEC = 300;
const DEFAULT_TIMESTAMP_TOLERANCE_SEC = parseInt(process.env.GATE_TIMESTAMP_TOLERANCE_SEC || '300', 10);

function issueNonce(ttlSec = DEFAULT_NONCE_TTL_SEC) {
  const now = Date.now();
  const nonce = generateNonce();
  db.prepare('INSERT INTO nonces (id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(generateId('nnc'), nonce, now, now + ttlSec * 1000);
  return { nonce, expiresAt: now + ttlSec * 1000 };
}

/**
 * Consume a nonce exactly once. Returns { valid, reason }.
 * A nonce is valid only the first time it is presented, before it expires.
 */
function consumeNonce(nonce) {
  if (!nonce) return { valid: false, reason: 'nonce_required' };
  const row = db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(nonce);
  if (!row) return { valid: false, reason: 'nonce_unknown' };
  if (row.used_at) return { valid: false, reason: 'nonce_already_used' };
  if (Date.now() > row.expires_at) return { valid: false, reason: 'nonce_expired' };

  const result = db.prepare('UPDATE nonces SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .run(Date.now(), row.id);
  if (result.changes === 0) return { valid: false, reason: 'nonce_already_used' };
  return { valid: true };
}

/**
 * Reject responses whose declared decided_at/timestamp falls outside a
 * configurable tolerance window around "now" — defeats both stale replay
 * of an old response and forged future-dated responses.
 */
function checkTimestampTolerance(timestamp, toleranceSec = DEFAULT_TIMESTAMP_TOLERANCE_SEC) {
  if (timestamp === undefined || timestamp === null) return { valid: true };
  const ts = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (Number.isNaN(ts)) return { valid: false, reason: 'timestamp_invalid' };
  const driftMs = Math.abs(Date.now() - ts);
  if (driftMs > toleranceSec * 1000) return { valid: false, reason: 'timestamp_out_of_tolerance' };
  return { valid: true };
}

module.exports = {
  DEFAULT_NONCE_TTL_SEC,
  DEFAULT_TIMESTAMP_TOLERANCE_SEC,
  issueNonce,
  consumeNonce,
  checkTimestampTolerance,
};
