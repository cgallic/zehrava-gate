const db = require('./db');
const { generateId } = require('./crypto');

function logEvent(proposalId, eventType, actor, metadata = {}) {
  const stmt = db.prepare(`
    INSERT INTO audit_events (id, proposal_id, event_type, actor, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    generateId('evt'),
    proposalId || null,
    eventType,
    actor || 'system',
    JSON.stringify(metadata),
    Date.now()
  );
}

function getAuditTrail(proposalId) {
  return db.prepare(`
    SELECT * FROM audit_events WHERE proposal_id = ? ORDER BY created_at ASC
  `).all(proposalId).map(e => ({
    ...e,
    metadata: JSON.parse(e.metadata || '{}'),
    created_at: new Date(e.created_at).toISOString()
  }));
}

module.exports = { logEvent, getAuditTrail };
