// Signature verification for inbound provider approval callbacks (issue
// #14). Standard contract for webhook-style providers:
//
//   X-Gate-Provider-Signature: t=<unix-ms>,v1=<hex-hmac-sha256>
//   X-Gate-Provider-Delivery-ID: <unique-per-delivery>
//
// v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), hex-encoded. A provider with
// its own signing scheme (e.g. a namespaced header) can normalize into this
// same shape before calling verifyProviderSignature — see kaicalls.js for
// where that adaptation would live once KaiCalls signs responses.
//
// Fails closed: no configured secret, missing header, malformed header,
// bad signature, or a timestamp outside tolerance are all rejected.

const crypto = require('crypto');

const DEFAULT_TOLERANCE_SEC = parseInt(process.env.GATE_TIMESTAMP_TOLERANCE_SEC || '300', 10);

function getProviderSecret(provider) {
  const envKey = `GATE_PROVIDER_SECRET_${String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envKey] || null;
}

function computeSignature(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function parseSignatureHeader(header) {
  if (!header) return null;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  if (!parts.t || !parts.v1) return null;
  return parts;
}

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function verifyProviderSignature({ provider, header, rawBody, toleranceSec = DEFAULT_TOLERANCE_SEC }) {
  const secret = getProviderSecret(provider);
  if (!secret) return { valid: false, reason: 'provider_secret_not_configured' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'signature_header_missing_or_malformed' };

  const expected = computeSignature(secret, parsed.t, rawBody || '');
  if (!timingSafeEqualHex(expected, parsed.v1)) return { valid: false, reason: 'signature_invalid' };

  const drift = Math.abs(Date.now() - parseInt(parsed.t, 10));
  if (Number.isNaN(drift) || drift > toleranceSec * 1000) return { valid: false, reason: 'signature_timestamp_stale' };

  return { valid: true };
}

module.exports = { getProviderSecret, computeSignature, verifyProviderSignature };
