/**
 * Canonical hashing and serialization for Run Ledger integrity
 */

const crypto = require('crypto');

/**
 * Canonicalize a JSON object for stable hashing
 * - Sorts keys recursively
 * - Removes undefined values
 * - Stable across key order
 */
function canonicalize(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  
  const sorted = {};
  Object.keys(obj).sort().forEach(key => {
    const val = obj[key];
    if (val !== undefined) {
      sorted[key] = canonicalize(val);
    }
  });
  return sorted;
}

/**
 * Compute SHA-256 hash of canonicalized JSON
 */
function hashObject(obj) {
  const canonical = canonicalize(obj);
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Compute hash of a string
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Generate a side-effect key for deduplication
 * Format: {action_type}:{target_resource}:{payload_hash}
 */
function sideEffectKey(actionType, targetResource, payload) {
  const payloadHash = hashObject(payload);
  const normalized = canonicalize({
    action: actionType,
    target: targetResource,
    payload: payloadHash
  });
  return hashObject(normalized);
}

/**
 * Compute integrity hash for a run ledger
 * Includes: run_id + agent_id + intent_summary + schema_version
 */
function ledgerIntegrityHash(runId, agentId, intentSummary, schemaVersion) {
  return hashObject({ runId, agentId, intentSummary, schemaVersion });
}

/**
 * Compute sealed hash for a checkpoint
 * Includes: checkpoint data + event history up to checkpoint
 */
function checkpointSealedHash(checkpointId, ledgerId, eventId, resumePacket, events) {
  return hashObject({
    checkpointId,
    ledgerId,
    eventId,
    resumePacket: canonicalize(resumePacket),
    eventHashes: events.map(e => hashObject({
      id: e.id,
      seq: e.seq,
      type: e.event_type,
      payload: e.payload_json
    }))
  });
}

module.exports = {
  canonicalize,
  hashObject,
  hashString,
  sideEffectKey,
  ledgerIntegrityHash,
  checkpointSealedHash
};
