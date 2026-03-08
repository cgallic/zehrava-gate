const crypto = require('crypto');

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function generateApiKey() {
  return `gate_sk_${crypto.randomBytes(24).toString('hex')}`;
}

function generateDeliveryToken() {
  return `dlv_${crypto.randomBytes(20).toString('hex')}`;
}

function generateExecutionToken() {
  return `gex_${crypto.randomBytes(20).toString('hex')}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function hashPayload(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseExpiry(expiresIn) {
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  const match = String(expiresIn).match(/^(\d+)([smhd]?)$/);
  if (!match) return 3600;
  const val = parseInt(match[1]);
  const unit = match[2] || 'h';
  return val * (units[unit] || 3600);
}

module.exports = { generateId, generateApiKey, generateDeliveryToken, generateExecutionToken, hashApiKey, hashPayload, parseExpiry };
