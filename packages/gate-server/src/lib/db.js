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
    role TEXT DEFAULT 'agent',
    status TEXT DEFAULT 'active',
    owner TEXT,
    allowed_policies TEXT,
    allowed_destinations TEXT,
    framework TEXT,
    metadata TEXT,
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
    on_behalf_of TEXT,
    idempotency_key TEXT,
    risk_score REAL,
    risk_level TEXT,
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

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    fired INTEGER DEFAULT 0,
    fired_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (intent_id) REFERENCES proposals(id)
  );

  CREATE TABLE IF NOT EXISTS policy_decisions (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason_code TEXT,
    reason_detail TEXT,
    risk_score REAL,
    risk_level TEXT,
    policy_snapshot TEXT,
    required_approvals INTEGER DEFAULT 1,
    evaluated_at INTEGER NOT NULL,
    FOREIGN KEY (intent_id) REFERENCES proposals(id)
  );

  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'runner_exec',
    destination TEXT NOT NULL,
    action TEXT,
    payload_ref TEXT,
    payload_hash TEXT,
    execution_token TEXT UNIQUE,
    retry_policy TEXT DEFAULT '{"max_attempts":3,"backoff_seconds":30}',
    status TEXT DEFAULT 'scheduled',
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    executed_at INTEGER,
    result TEXT,
    FOREIGN KEY (intent_id) REFERENCES proposals(id)
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_sender_created ON proposals(sender_agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_proposals_status_created ON proposals(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_policy_decisions_intent ON policy_decisions(intent_id);
  CREATE INDEX IF NOT EXISTS idx_executions_intent ON executions(intent_id);
  CREATE INDEX IF NOT EXISTS idx_executions_token ON executions(execution_token);
`);

// ── Lightweight migrations (no drops; add columns only) ───────────────────
function ensureColumn(sql) {
  try { db.exec(sql); }
  catch (e) {
    const msg = (e && e.message) ? e.message.toLowerCase() : '';
    if (msg.includes('duplicate column') || msg.includes('already exists')) return;
    throw e;
  }
}

ensureColumn("ALTER TABLE agents ADD COLUMN role TEXT DEFAULT 'agent'");
ensureColumn("ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'");

// proposals: V2 columns added after initial schema
ensureColumn("ALTER TABLE proposals ADD COLUMN sensitivity_tags TEXT DEFAULT '[]'");
ensureColumn("ALTER TABLE proposals ADD COLUMN estimated_records INTEGER");
ensureColumn("ALTER TABLE proposals ADD COLUMN estimated_value_usd REAL");
ensureColumn("ALTER TABLE proposals ADD COLUMN action TEXT");
ensureColumn("ALTER TABLE proposals ADD COLUMN approved_at INTEGER");

module.exports = db;
