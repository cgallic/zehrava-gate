// A2H (Agent-to-Human) v1.0 wire-format helpers — the open protocol behind
// Twilio's Ola (spec: https://github.com/twilio-labs/Agent2Human,
// a2h_framework.md). Used by the a2h approval provider, the spec-format
// callback path in routes/approvals.js, and the status poller.
//
// Everything here is pure protocol plumbing: building the AUTHORIZE
// envelope, resolving gateway endpoints, normalizing RESPONSE/status
// payloads, and verifying the gateway's detached JWS over the JCS-canonical
// message (spec §1.11.2). Trust decisions stay in the callers.

const crypto = require('crypto');

const A2H_VERSION = '1.0';

// Gateway-reported interaction states (spec §1.6).
const A2H_STATES = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  WAITING_INPUT: 'WAITING_INPUT',
  ANSWERED: 'ANSWERED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
};
const A2H_OPEN_STATES = new Set([A2H_STATES.PENDING, A2H_STATES.SENT, A2H_STATES.WAITING_INPUT]);

// ── Endpoints ────────────────────────────────────────────────────────────

// `gateway_url` may be the gateway's base URL ("https://gw.example.com") or
// an explicit intent endpoint ("https://gw.example.com/v1/intent"). Any other
// explicit /v1/<path> is honoured as-is for the intent call (older configs
// pointed at /v1/authorize), with status/cancel derived from the base.
function resolveGatewayEndpoints(gatewayUrl) {
  if (!gatewayUrl) throw new Error('a2h gateway_url is required');
  const trimmed = String(gatewayUrl).replace(/\/+$/, '');
  const match = trimmed.match(/^(.*)\/v1\/[^/]+$/);
  const base = match ? match[1] : trimmed;
  return {
    base,
    intent: match ? trimmed : `${base}/v1/intent`,
    status: (interactionId) => `${base}/v1/status/${encodeURIComponent(interactionId)}`,
    cancel: (interactionId) => `${base}/v1/cancel/${encodeURIComponent(interactionId)}`,
    discovery: `${base}/.well-known/a2h`,
  };
}

// Spec §1.8.3 recommends X-A2H-API-Key; the reference gateway expects a
// Bearer token. Sending both by default works with either.
function gatewayAuthHeaders(apiKey, mode = 'both') {
  const headers = {};
  if (!apiKey) return headers;
  if (mode === 'both' || mode === 'api_key') headers['X-A2H-API-Key'] = apiKey;
  if (mode === 'both' || mode === 'bearer') headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

// ── Outbound AUTHORIZE ───────────────────────────────────────────────────

function buildAuthorizeMessage({
  messageId,
  agentId,
  principalId,
  channel,
  render,
  ttlSec,
  assurance,
  explanation,
  callback,
  params,
  links,
  createdAt = new Date(),
}) {
  const message = {
    a2h_version: A2H_VERSION,
    a2h_min_version: A2H_VERSION,
    type: 'AUTHORIZE',
    message_id: messageId,
    agent_id: agentId,
    principal_id: principalId,
    // render is repeated at the top level: the spec's AUTHORIZE example and
    // the reference gateway read it there, the envelope nests it in channel.
    render,
    ttl_sec: ttlSec,
    created_at: createdAt.toISOString(),
  };
  if (channel) message.channel = { ...channel, render };
  if (assurance) message.assurance = assurance;
  if (explanation) message.explanation_bundle = explanation;
  if (callback) message.callback = callback;
  if (links && Object.keys(links).length) message.links = links;
  if (params && Object.keys(params).length) message.params = params;
  return message;
}

// Per-interaction webhook secret (spec §1.12.2 has the agent hand the
// gateway a `callback.secret`). Deriving it from GATE_PROVIDER_SECRET_A2H
// and the message_id means a gateway only ever learns the secret for the
// interactions it was sent — never one that could sign another gateway's.
function deriveCallbackSecret(masterSecret, messageId) {
  if (!masterSecret || !messageId) return null;
  return `whsec_${crypto.createHmac('sha256', masterSecret).update(`a2h-callback:${messageId}`).digest('hex')}`;
}

// ── Inbound RESPONSE / status ────────────────────────────────────────────

// Normalizes a webhook RESPONSE (§1.3), an ERROR (§1.3) or a status-poll
// body (§1.7) into one shape. Never throws; missing fields come back null.
function normalizeResponse(body = {}) {
  const type = body.type ? String(body.type).toUpperCase() : null;
  const decision = body.decision ? String(body.decision).toUpperCase() : null;
  let state = body.state || body.status || null;
  state = state ? String(state).toUpperCase() : null;
  if (!state && type === 'RESPONSE' && decision) state = A2H_STATES.ANSWERED;
  const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : null;
  return {
    type,
    state,
    interactionId: body.interaction_id || null,
    respondsTo: body.responds_to || null,
    decision,
    decidedAt: body.decided_at || null,
    evidence,
    factor: evidence?.factor || null,
    error: body.error && typeof body.error === 'object' ? body.error : null,
    signature: typeof body.signature === 'string' ? body.signature : null,
  };
}

// ── JCS + detached JWS (spec §1.11.2) ────────────────────────────────────

// RFC 8785 JSON Canonicalization: sorted keys (UTF-16 code unit order,
// which is JS's default string sort), no whitespace, ES number formatting.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const JWS_ALGS = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  EdDSA: { hash: null },
};

// Payload the gateway signs: the JCS form of the message minus `signature`.
function signingPayload(message) {
  const { signature, ...rest } = message || {};
  return canonicalize(rest);
}

// Verifies `message.signature`, a detached compact JWS
// ("<b64 header>..<b64 sig>") — a full compact JWS whose payload equals the
// canonical message is accepted too. Fails closed on anything unexpected.
function verifyDetachedJws(message, jwks) {
  const jws = message?.signature;
  if (!jws || typeof jws !== 'string') return { valid: false, reason: 'signature_missing' };
  const parts = jws.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'signature_malformed' };
  const [encodedHeader, encodedPayload, encodedSig] = parts;

  let header;
  try { header = JSON.parse(fromB64url(encodedHeader).toString('utf8')); } catch { return { valid: false, reason: 'signature_header_invalid' }; }
  const alg = JWS_ALGS[header.alg];
  if (!alg) return { valid: false, reason: 'signature_alg_unsupported', alg: header.alg };

  const expectedPayload = b64url(Buffer.from(signingPayload(message), 'utf8'));
  if (encodedPayload && encodedPayload !== expectedPayload) return { valid: false, reason: 'signature_payload_mismatch' };

  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (!candidates.length) return { valid: false, reason: 'signature_key_not_found', kid: header.kid || null };

  const signingInput = Buffer.from(`${encodedHeader}.${expectedPayload}`, 'utf8');
  const sig = fromB64url(encodedSig);
  for (const jwk of candidates) {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const options = { key };
      if (alg.dsaEncoding) options.dsaEncoding = alg.dsaEncoding;
      if (alg.padding) { options.padding = alg.padding; options.saltLength = alg.saltLength; }
      if (crypto.verify(alg.hash, signingInput, options, sig)) {
        return { valid: true, alg: header.alg, kid: jwk.kid || header.kid || null };
      }
    } catch {
      // Key/alg mismatch — try the next candidate.
    }
  }
  return { valid: false, reason: 'signature_invalid', kid: header.kid || null };
}

// Signs a message the way a gateway would. Used by tests and the example
// mock gateway; Gate itself never signs RESPONSEs.
function signDetachedJws(message, privateKey, { alg = 'ES256', kid } = {}) {
  const spec = JWS_ALGS[alg];
  if (!spec) throw new Error(`Unsupported JWS alg: ${alg}`);
  const header = b64url(Buffer.from(JSON.stringify(kid ? { alg, kid } : { alg }), 'utf8'));
  const payload = b64url(Buffer.from(signingPayload(message), 'utf8'));
  const options = { key: privateKey };
  if (spec.dsaEncoding) options.dsaEncoding = spec.dsaEncoding;
  if (spec.padding) { options.padding = spec.padding; options.saltLength = spec.saltLength; }
  const sig = crypto.sign(spec.hash, Buffer.from(`${header}.${payload}`, 'utf8'), options);
  return `${header}..${b64url(sig)}`;
}

// JWKS fetch with a short in-process cache — the key set changes rarely and
// every callback would otherwise add a network round trip.
const JWKS_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map();

async function fetchJwks(uri, { force = false } = {}) {
  const cached = jwksCache.get(uri);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.jwks;
  const res = await fetch(uri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const jwks = await res.json();
  jwksCache.set(uri, { jwks, fetchedAt: Date.now() });
  return jwks;
}

function clearJwksCache() {
  jwksCache.clear();
}

module.exports = {
  A2H_VERSION,
  A2H_STATES,
  A2H_OPEN_STATES,
  resolveGatewayEndpoints,
  gatewayAuthHeaders,
  buildAuthorizeMessage,
  deriveCallbackSecret,
  normalizeResponse,
  canonicalize,
  signingPayload,
  verifyDetachedJws,
  signDetachedJws,
  fetchJwks,
  clearJwksCache,
};
