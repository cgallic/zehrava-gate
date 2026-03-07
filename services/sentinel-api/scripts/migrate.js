const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './sentinel.db';
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Events table - raw telemetry from agents
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload JSON,
    timestamp INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
`);

// Incidents table - grouped failures
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    first_event_id TEXT,
    last_event_id TEXT,
    event_count INTEGER DEFAULT 1,
    started_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    resolved_at INTEGER,
    alert_sent BOOLEAN DEFAULT FALSE,
    context JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_agent ON incidents(agent_id);
  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
`);

// Alerts table - notification log
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    payload JSON,
    response_status INTEGER,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_incident ON alerts(incident_id);
`);

// Agent registry - known agents
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at INTEGER
  );
`);

console.log('Database migrated successfully');
db.close();
