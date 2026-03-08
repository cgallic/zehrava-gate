'use strict';

/**
 * Gate V3 — Auto-Replay Hold Queue (singleton)
 *
 * Stores pending proxy requests in memory.
 * On approval, releases the entry and triggers its resolve() callback.
 */

const entries = new Map(); // intentId -> entry

const DEFAULT_TTL_MS = parseInt(process.env.GATE_HOLD_TIMEOUT_MS || String(15 * 60 * 1000));

function add(intentId, requestData, resolve, reject, ttlMs = DEFAULT_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  entries.set(intentId, {
    intentId,
    request: requestData,
    resolve,
    reject,
    expiresAt,
  });
  console.log(`[hold-queue] hold ${intentId} (ttl=${Math.floor(ttlMs/1000)}s)`);
}

function release(intentId) {
  const entry = entries.get(intentId);
  if (!entry) return null;
  entries.delete(intentId);
  return entry;
}

function cancel(intentId, reason) {
  const entry = entries.get(intentId);
  if (!entry) return false;
  try { entry.reject(new Error(reason || 'cancelled')); } catch {}
  entries.delete(intentId);
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of entries.entries()) {
    if (entry.expiresAt <= now) {
      try { entry.reject(new Error('Request timed out while waiting for approval')); } catch {}
      entries.delete(id);
      console.log(`[hold-queue] expired ${id}`);
    }
  }
}

function size() {
  return entries.size;
}

function list() {
  const out = [];
  for (const [id, e] of entries.entries()) {
    const r = e.request || {};
    out.push({
      intentId: id,
      hostname: r.hostname,
      path: r.path,
      method: r.method,
      createdAt: e.expiresAt - (r.ttlMs || DEFAULT_TTL_MS),
      expiresAt: e.expiresAt,
      type: r.type || 'http',
    });
  }
  return out;
}

module.exports = {
  add,
  release,
  cancel,
  sweep,
  size,
  list,
  DEFAULT_TTL_MS,
};
