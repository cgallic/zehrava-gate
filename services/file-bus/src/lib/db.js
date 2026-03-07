require('dotenv').config();
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const db = new Database(process.env.FILE_BUS_DB_PATH || './file-bus.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Agents ──────────────────────────────────────────────────

function registerAgent({ agent_id, name, api_key, trust_level = 'standard', metadata = {} }) {
  db.prepare(`
    INSERT INTO agents (agent_id, name, api_key, trust_level, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent_id, name, api_key, trust_level, JSON.stringify(metadata));
  return getAgent(agent_id);
}

function getAgentByKey(api_key) {
  const row = db.prepare('SELECT * FROM agents WHERE api_key = ? AND status = ?').get(api_key, 'active');
  return row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null;
}

function getAgent(agent_id) {
  const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  return row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null;
}

// ── Files ────────────────────────────────────────────────────

function createFile({ file_id, uploader_id, original_name, storage_path, content_hash, size_bytes, mime_type, metadata = {} }) {
  db.prepare(`
    INSERT INTO files (file_id, uploader_id, original_name, storage_path, content_hash, size_bytes, mime_type, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(file_id, uploader_id, original_name, storage_path, content_hash, size_bytes, mime_type || 'application/octet-stream', JSON.stringify(metadata));
  return getFile(file_id);
}

function getFile(file_id) {
  const row = db.prepare('SELECT * FROM files WHERE file_id = ? AND status = ?').get(file_id, 'active');
  return row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null;
}

// ── Grants ───────────────────────────────────────────────────

function createGrant({ grant_id, file_id, sender_id, recipient_id, permissions = ['read', 'download'], expires_at }) {
  db.prepare(`
    INSERT INTO grants (grant_id, file_id, sender_id, recipient_id, permissions, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(grant_id, file_id, sender_id, recipient_id, JSON.stringify(permissions), expires_at || null);
  return getGrant(grant_id);
}

function getGrant(grant_id) {
  const row = db.prepare('SELECT * FROM grants WHERE grant_id = ?').get(grant_id);
  return row ? { ...row, permissions: JSON.parse(row.permissions || '[]') } : null;
}

function getActiveGrant(file_id, recipient_id) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT * FROM grants 
    WHERE file_id = ? AND recipient_id = ? AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 1
  `).get(file_id, recipient_id, now);
  return row ? { ...row, permissions: JSON.parse(row.permissions || '[]') } : null;
}

function revokeGrant(grant_id) {
  db.prepare('UPDATE grants SET revoked_at = ? WHERE grant_id = ?').run(Date.now(), grant_id);
}

function getFileGrants(file_id) {
  return db.prepare('SELECT * FROM grants WHERE file_id = ? ORDER BY created_at DESC').all(file_id)
    .map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') }));
}

// ── Manifests ────────────────────────────────────────────────

function createManifest({ manifest_id, file_id, grant_id, sender_id, recipient_id, content_hash, signature, expires_at }) {
  db.prepare(`
    INSERT INTO manifests (manifest_id, file_id, grant_id, sender_id, recipient_id, content_hash, signature, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(manifest_id, file_id, grant_id || null, sender_id, recipient_id || null, content_hash, signature, expires_at || null);
  return getManifest(manifest_id);
}

function getManifest(manifest_id) {
  return db.prepare('SELECT * FROM manifests WHERE manifest_id = ?').get(manifest_id);
}

function getFileManifest(file_id) {
  return db.prepare('SELECT * FROM manifests WHERE file_id = ? ORDER BY created_at DESC LIMIT 1').get(file_id);
}

// ── Download Tokens ──────────────────────────────────────────

function createDownloadToken({ token, file_id, agent_id, grant_id, ttl_ms = 300000 }) {
  const expires_at = Date.now() + ttl_ms;
  db.prepare(`
    INSERT INTO download_tokens (token, file_id, agent_id, grant_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, file_id, agent_id, grant_id || null, expires_at);
  return { token, file_id, agent_id, expires_at };
}

function consumeDownloadToken(token) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM download_tokens WHERE token = ? AND used = 0 AND expires_at > ?').get(token, now);
  if (!row) return null;
  db.prepare('UPDATE download_tokens SET used = 1 WHERE token = ?').run(token);
  return row;
}

// ── Audit Log ────────────────────────────────────────────────

function audit({ actor_id, action, target_id, target_type, outcome = 'success', details = {} }) {
  const event_id = 'aud_' + uuidv4().replace(/-/g, '');
  db.prepare(`
    INSERT INTO audit_log (event_id, actor_id, action, target_id, target_type, outcome, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(event_id, actor_id || null, action, target_id || null, target_type || null, outcome, JSON.stringify(details));
  return event_id;
}

function getAuditLog({ actor_id, target_id, action, limit = 50 } = {}) {
  let query = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (actor_id) { query += ' AND actor_id = ?'; params.push(actor_id); }
  if (target_id) { query += ' AND target_id = ?'; params.push(target_id); }
  if (action) { query += ' AND action = ?'; params.push(action); }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(query).all(...params).map(r => ({ ...r, details: JSON.parse(r.details || '{}') }));
}

module.exports = {
  registerAgent, getAgentByKey, getAgent,
  createFile, getFile,
  createGrant, getGrant, getActiveGrant, revokeGrant, getFileGrants,
  createManifest, getManifest, getFileManifest,
  createDownloadToken, consumeDownloadToken,
  audit, getAuditLog,
  close: () => db.close()
};
