require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.FILE_BUS_DB_PATH || './file-bus.db';
const db = new Database(dbPath);

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  -- Agent identities
  CREATE TABLE IF NOT EXISTS agents (
    agent_id    TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    name        TEXT NOT NULL,
    api_key     TEXT NOT NULL UNIQUE,
    trust_level TEXT NOT NULL DEFAULT 'standard',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    metadata    TEXT DEFAULT '{}'
  );

  -- Files
  CREATE TABLE IF NOT EXISTS files (
    file_id         TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    uploader_id     TEXT NOT NULL REFERENCES agents(agent_id),
    original_name   TEXT NOT NULL,
    storage_path    TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    mime_type       TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    metadata        TEXT DEFAULT '{}'
  );

  -- Share grants
  CREATE TABLE IF NOT EXISTS grants (
    grant_id        TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL REFERENCES files(file_id),
    sender_id       TEXT NOT NULL REFERENCES agents(agent_id),
    recipient_id    TEXT NOT NULL REFERENCES agents(agent_id),
    permissions     TEXT NOT NULL DEFAULT '["read","download"]',
    expires_at      INTEGER,
    revoked_at      INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- Manifests (signed handoff records)
  CREATE TABLE IF NOT EXISTS manifests (
    manifest_id     TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL REFERENCES files(file_id),
    grant_id        TEXT REFERENCES grants(grant_id),
    sender_id       TEXT NOT NULL,
    recipient_id    TEXT,
    content_hash    TEXT NOT NULL,
    signature       TEXT NOT NULL,
    expires_at      INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- Download tokens (short-lived)
  CREATE TABLE IF NOT EXISTS download_tokens (
    token           TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL REFERENCES files(file_id),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id),
    grant_id        TEXT REFERENCES grants(grant_id),
    used            INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- Immutable audit log
  CREATE TABLE IF NOT EXISTS audit_log (
    event_id        TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    actor_id        TEXT,
    action          TEXT NOT NULL,
    target_id       TEXT,
    target_type     TEXT,
    outcome         TEXT NOT NULL DEFAULT 'success',
    ip_meta         TEXT,
    policy_ref      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    details         TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);
  CREATE INDEX IF NOT EXISTS idx_grants_file ON grants(file_id);
  CREATE INDEX IF NOT EXISTS idx_grants_recipient ON grants(recipient_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_id, created_at);
`);

console.log('File Bus database migrated successfully');
db.close();
