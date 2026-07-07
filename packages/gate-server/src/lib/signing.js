const crypto = require('crypto');
const db = require('./db');
const { generateId } = require('./crypto');

// A detached JWS (RFC 7797 style, HS256) over a canonical JSON payload.
// The payload itself is not embedded in the token — callers must reconstruct
// and re-canonicalize it to verify, which is what "detached" buys us: the
// evidence bundle can carry the signature without duplicating the payload.

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getSigningSecret() {
  const existing = db.prepare('SELECT secret FROM server_keys WHERE id = ?').get('default');
  if (existing) return existing.secret;

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    db.prepare('INSERT INTO server_keys (id, secret, created_at) VALUES (?, ?, ?)')
      .run('default', secret, Date.now());
  } catch (e) {
    // Lost the race with another process initializing the key — re-read.
    const row = db.prepare('SELECT secret FROM server_keys WHERE id = ?').get('default');
    if (row) return row.secret;
    throw e;
  }
  return secret;
}

// Deterministic canonical JSON: sorts object keys recursively so the same
// logical payload always hashes/signs to the same string.
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Returns a compact detached JWS string: base64url(header)..base64url(signature)
function signDetached(payloadObj) {
  const secret = getSigningSecret();
  const header = { alg: 'HS256', typ: 'gate-jws', crit: ['b64'], b64: false };
  const canonicalPayload = canonicalize(payloadObj);
  const encodedHeader = base64url(JSON.stringify(header));
  const signingInput = `${encodedHeader}.${canonicalPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${encodedHeader}..${base64url(signature)}`;
}

function verifyDetached(jws, payloadObj) {
  if (!jws || typeof jws !== 'string') return false;
  const parts = jws.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, , encodedSignature] = parts;
  const secret = getSigningSecret();
  const canonicalPayload = canonicalize(payloadObj);
  const signingInput = `${encodedHeader}.${canonicalPayload}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const expectedEncoded = base64url(expected);
  if (expectedEncoded.length !== encodedSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedEncoded), Buffer.from(encodedSignature));
}

module.exports = { canonicalize, sha256Hex, signDetached, verifyDetached, getSigningSecret };
