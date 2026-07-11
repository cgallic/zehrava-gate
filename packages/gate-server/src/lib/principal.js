// Principal/channel model (issue #4): a stable, opaque human identity
// (principal_id) is kept separate from the routable address used to reach
// them (channel.address). This keeps PII out of audit records that get
// logged/exported long-term, and lets policy reason about assurance level
// independent of which address happens to be on file.

function looksLikeEmailOrPhone(value) {
  if (!value) return false;
  const str = String(value).trim();
  if (str.includes('@')) return true;
  if (/^\+?[\d\s().-]{7,}$/.test(str)) return true;
  return false;
}

// Redacts a routable address for safe storage in logs/audit. Keeps just
// enough to be recognizable to the human who owns it, nothing more:
//   "+15550001234"        -> "tel:+155****1234"
//   "connor@example.com"  -> "email:c***@example.com"
function redactChannelAddress(address) {
  if (!address) return null;
  const str = String(address).trim();

  const mailto = str.replace(/^mailto:/i, '');
  if (mailto.includes('@')) {
    const [local, domain] = mailto.split('@');
    const visible = local.slice(0, 1) || '*';
    return `email:${visible}***@${domain}`;
  }

  const tel = str.replace(/^tel:/i, '');
  if (/^\+?\d{4,}$/.test(tel)) {
    const last4 = tel.slice(-4);
    const head = tel.slice(0, Math.max(tel.length - 4, 0)).slice(0, 4);
    return `tel:${head}****${last4}`;
  }

  return `redacted:${str.slice(0, 2)}***`;
}

// Validates that a proposed principal/channel pair keeps stable identity and
// routable address properly separated. Returns { valid, errors }.
function validatePrincipal({ principal_id, channel } = {}) {
  const errors = [];
  if (looksLikeEmailOrPhone(principal_id)) {
    errors.push(
      'principal_id must be a stable opaque identifier (e.g. usr_abc123), not an email or phone number — ' +
      'put the routable address in channel.address instead'
    );
  }
  if (channel && channel.address && !channel.type) {
    errors.push('channel.type is required when channel.address is set');
  }
  return { valid: errors.length === 0, errors };
}

// HIGH/CRITICAL assurance levels require a verified channel (or an explicit
// policy override) — a freshly-supplied, unverified phone/email is not
// enough to authorize a high-risk action.
function assuranceSatisfiedByChannel({ level, channelVerified, allowUnverifiedOverride = false }) {
  if (level === 'HIGH' || level === 'CRITICAL') {
    return !!channelVerified || allowUnverifiedOverride;
  }
  return true;
}

module.exports = {
  looksLikeEmailOrPhone,
  redactChannelAddress,
  validatePrincipal,
  assuranceSatisfiedByChannel,
};
