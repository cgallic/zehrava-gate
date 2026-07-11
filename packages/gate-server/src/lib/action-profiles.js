// Typed, versioned action profiles for common high-risk categories (issue
// #10). The base propose/approve/execute protocol stays generic — a
// profile adds a required-field shape, deterministic canonicalization for
// hashing, and a human-readable summary for approval rendering, matching
// A2H's approach of versioned profiles (e.g. `transaction.v1`) layered on
// top of a generic base protocol.
//
// Profile fields are read from the propose request's `metadata` object —
// Gate's existing generic bag for structured context alongside a raw
// payload/file. Required-field validation runs before policy evaluation,
// and the canonical hash of just the profile's required fields is folded
// into the intent's approval-evidence hash binding (lib/evidence.js), so
// tampering with profile fields after approval is caught the same way
// tampering with destination/payload already is.

const { canonicalize, sha256Hex } = require('./signing');

const PROFILES = {
  'email.send.v1': {
    requiredFields: ['to', 'subject'],
    redactFields: ['to'],
    summarize: (f) => `Send email to ${f.to} — "${f.subject}"`,
  },
  'crm.import.v1': {
    requiredFields: ['object_type', 'record_count'],
    redactFields: [],
    summarize: (f) => `Import ${f.record_count} ${f.object_type} record(s)`,
  },
  'payment.refund.v1': {
    requiredFields: ['amount_usd', 'reason'],
    redactFields: [],
    summarize: (f) => `Refund $${f.amount_usd} — ${f.reason}`,
  },
  'finance.journal.v1': {
    requiredFields: ['account', 'amount_usd', 'memo'],
    redactFields: [],
    summarize: (f) => `Journal entry on ${f.account}: $${f.amount_usd} — ${f.memo}`,
  },
  'support.reply.v1': {
    requiredFields: ['ticket_id', 'body'],
    redactFields: [],
    summarize: (f) => `Reply to support ticket ${f.ticket_id}`,
  },
  'social.publish.v1': {
    requiredFields: ['platform', 'body'],
    redactFields: [],
    summarize: (f) => `Publish to ${f.platform}: "${String(f.body).slice(0, 60)}${String(f.body).length > 60 ? '…' : ''}"`,
  },
};

function getProfile(id) {
  return PROFILES[id] || null;
}

function listProfiles() {
  return Object.keys(PROFILES);
}

function validateProfilePayload(profileId, fields) {
  const profile = getProfile(profileId);
  if (!profile) return { valid: false, errors: [`Unknown profile: ${profileId}`] };
  const errors = [];
  for (const field of profile.requiredFields) {
    const value = fields?.[field];
    if (value === undefined || value === null || value === '') {
      errors.push(`Missing required field "${field}" for profile "${profileId}"`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Deterministic hash of just a profile's required fields (sorted), so the
// same logical payload always hashes the same way regardless of what else
// is in `metadata`, and any change to a required field changes the hash.
function canonicalProfileFieldsHash(profileId, fields) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  const picked = {};
  for (const field of [...profile.requiredFields].sort()) {
    picked[field] = fields?.[field] ?? null;
  }
  return sha256Hex(canonicalize(picked));
}

function redactProfileFields(profileId, fields) {
  const profile = getProfile(profileId);
  if (!profile || !fields) return fields;
  const redacted = { ...fields };
  for (const field of profile.redactFields || []) {
    if (redacted[field] !== undefined) redacted[field] = '[redacted]';
  }
  return redacted;
}

function summarizeProfile(profileId, fields) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  try {
    return profile.summarize(fields || {});
  } catch {
    return null;
  }
}

module.exports = {
  PROFILES,
  getProfile,
  listProfiles,
  validateProfilePayload,
  canonicalProfileFieldsHash,
  redactProfileFields,
  summarizeProfile,
};
