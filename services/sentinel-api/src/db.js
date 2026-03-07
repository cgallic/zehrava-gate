const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './sentinel.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Event operations
function createEvent(event) {
  const stmt = getDb().prepare(`
    INSERT INTO events (id, agent_id, run_id, type, payload, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    event.id,
    event.agent_id,
    event.run_id,
    event.type,
    JSON.stringify(event.payload || {}),
    event.timestamp || Date.now()
  );
}

function getEventsForRun(runId, limit = 50) {
  const stmt = getDb().prepare(`
    SELECT * FROM events 
    WHERE run_id = ? 
    ORDER BY timestamp DESC 
    LIMIT ?
  `);
  return stmt.all(runId, limit).map(row => ({
    ...row,
    payload: JSON.parse(row.payload || '{}')
  }));
}

function getRecentEvents(agentId, minutes = 5) {
  const since = Date.now() - (minutes * 60 * 1000);
  const stmt = getDb().prepare(`
    SELECT * FROM events 
    WHERE agent_id = ? AND timestamp > ?
    ORDER BY timestamp DESC
  `);
  return stmt.all(agentId, since).map(row => ({
    ...row,
    payload: JSON.parse(row.payload || '{}')
  }));
}

// Incident operations
function createIncident(incident) {
  const stmt = getDb().prepare(`
    INSERT INTO incidents (id, agent_id, run_id, type, severity, first_event_id, started_at, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    incident.id,
    incident.agent_id,
    incident.run_id,
    incident.type,
    incident.severity,
    incident.first_event_id,
    incident.started_at || Date.now(),
    JSON.stringify(incident.context || {})
  );
}

function getIncident(id) {
  const stmt = getDb().prepare('SELECT * FROM incidents WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.context = JSON.parse(row.context || '{}');
  }
  return row;
}

function getIncidents({ agent_id, status, severity, limit = 50 }) {
  let sql = 'SELECT * FROM incidents WHERE 1=1';
  const params = [];
  
  if (agent_id) {
    sql += ' AND agent_id = ?';
    params.push(agent_id);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }
  
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);
  
  const stmt = getDb().prepare(sql);
  return stmt.all(...params).map(row => ({
    ...row,
    context: JSON.parse(row.context || '{}')
  }));
}

function updateIncidentStatus(id, status) {
  const updates = { status };
  if (status === 'acknowledged') {
    updates.acknowledged_at = Date.now();
  } else if (status === 'resolved') {
    updates.resolved_at = Date.now();
  }
  
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const stmt = getDb().prepare(`UPDATE incidents SET ${fields} WHERE id = ?`);
  return stmt.run(...Object.values(updates), id);
}

function markAlertSent(incidentId) {
  const stmt = getDb().prepare('UPDATE incidents SET alert_sent = TRUE WHERE id = ?');
  return stmt.run(incidentId);
}

function incrementEventCount(incidentId) {
  const stmt = getDb().prepare(`
    UPDATE incidents 
    SET event_count = event_count + 1 
    WHERE id = ?
  `);
  return stmt.run(incidentId);
}

// Alert operations
function createAlert(alert) {
  const stmt = getDb().prepare(`
    INSERT INTO alerts (id, incident_id, channel, payload, response_status, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    alert.id,
    alert.incident_id,
    alert.channel,
    JSON.stringify(alert.payload || {}),
    alert.response_status,
    alert.sent_at || Date.now()
  );
}

// Agent operations
function registerAgent(agent) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO agents (id, name, config, last_seen_at)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(
    agent.id,
    agent.name,
    JSON.stringify(agent.config || {}),
    Date.now()
  );
}

function getAgent(id) {
  const stmt = getDb().prepare('SELECT * FROM agents WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.config = JSON.parse(row.config || '{}');
  }
  return row;
}

module.exports = {
  getDb,
  closeDb,
  createEvent,
  getEventsForRun,
  getRecentEvents,
  createIncident,
  getIncident,
  getIncidents,
  updateIncidentStatus,
  markAlertSent,
  incrementEventCount,
  createAlert,
  registerAgent,
  getAgent
};
