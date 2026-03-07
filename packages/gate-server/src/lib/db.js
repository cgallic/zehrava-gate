const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'gate.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    risk_tier TEXT DEFAULT 'standard',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    sender_agent_id TEXT NOT NULL,
    payload_path TEXT,
    payload_hash TEXT,
    payload_type TEXT,
    destination TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending_approval',
    block_reason TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    FOREIGN KEY (sender_agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS manifests (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE,
    signed_by TEXT,
    recipient TEXT,
    delivery_token TEXT UNIQUE,
    delivered_at INTEGER,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    proposal_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
