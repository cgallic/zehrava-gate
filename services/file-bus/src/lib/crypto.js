const crypto = require('crypto');

// Generate a secure API key for an agent
function generateApiKey() {
  return 'fbus_' + crypto.randomBytes(32).toString('hex');
}

// Generate a download token
function generateDownloadToken() {
  return 'dt_' + crypto.randomBytes(24).toString('hex');
}

// Compute SHA-256 hash of a buffer
function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Sign a manifest payload (HMAC-SHA256 with server secret)
function signManifest(payload) {
  const secret = process.env.MANIFEST_SECRET || 'dev-secret-change-in-production';
  const data = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Verify a manifest signature
function verifyManifest(payload, signature) {
  const expected = signManifest(payload);
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature, 'hex')
  );
}

module.exports = { generateApiKey, generateDownloadToken, hashBuffer, signManifest, verifyManifest };
