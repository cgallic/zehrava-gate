/**
 * Run Ledger service - manages run creation, event recording, and state tracking
 */

const db = require('../db');
const { generateId } = require('../crypto');
const { hashObject, ledgerIntegrityHash, sideEffectKey } = require('./hash');
const { EVENT_TYPES, RUN_STATUS, EVENT_STATUS, SIDE_EFFECT_CLASS } = require('./constants');

class RunLedger {
  /**
   * Start a new run
   */
  static start({ agentId, intentSummary, runtime = 'zehrava-gate', parentRunId = null, permissions = {} }) {
    const runId = generateId('run');
    const ledgerId = generateId('ledger');
    const now = Date.now();
    const schemaVersion = 1;
    
    const integrityHash = ledgerIntegrityHash(runId, agentId, intentSummary, schemaVersion);
    
    const stmt = db.prepare(`
      INSERT INTO run_ledgers (
        id, run_id, parent_run_id, runtime, agent_id, intent_summary,
        status, permissions_json, integrity_hash, schema_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      ledgerId,
      runId,
      parentRunId,
      runtime,
      agentId,
      intentSummary,
      RUN_STATUS.ACTIVE,
      JSON.stringify(permissions),
      integrityHash,
      schemaVersion,
      now,
      now
    );
    
    // Record run_started event
    this.recordEvent({
      ledgerId,
      eventType: EVENT_TYPES.RUN_STARTED,
      actorId: agentId,
      payload: { runId, intentSummary, runtime, permissions }
    });
    
    return {
      runId,
      ledgerId,
      status: RUN_STATUS.ACTIVE,
      createdAt: now
    };
  }
  
  /**
   * Record an event in the ledger
   */
  static recordEvent({
    ledgerId,
    eventType,
    actorId = null,
    stepName = null,
    payload = {},
    inputHash = null,
    outputHash = null,
    sideEffectClass = SIDE_EFFECT_CLASS.NONE,
    sideEffectKey = null,
    status = EVENT_STATUS.RECORDED
  }) {
    const eventId = generateId('evt');
    const now = Date.now();
    
    // Get next sequence number
    const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE ledger_id = ?').get(ledgerId);
    const seq = seqRow.next_seq;
    
    const stmt = db.prepare(`
      INSERT INTO run_events (
        id, ledger_id, seq, event_type, event_ts, actor_id, step_name,
        payload_json, input_hash, output_hash, side_effect_class,
        side_effect_key, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      eventId,
      ledgerId,
      seq,
      eventType,
      now,
      actorId,
      stepName,
      JSON.stringify(payload),
      inputHash,
      outputHash,
      sideEffectClass,
      sideEffectKey,
      status,
      now
    );
    
    // Update ledger updated_at
    db.prepare('UPDATE run_ledgers SET updated_at = ? WHERE id = ?').run(now, ledgerId);
    
    return {
      eventId,
      seq,
      eventType,
      timestamp: now
    };
  }
  
  /**
   * Get run by run_id
   */
  static getRun(runId) {
    return db.prepare('SELECT * FROM run_ledgers WHERE run_id = ?').get(runId);
  }
  
  /**
   * Get ledger by ledger_id
   */
  static getLedger(ledgerId) {
    return db.prepare('SELECT * FROM run_ledgers WHERE id = ?').get(ledgerId);
  }
  
  /**
   * Get all events for a run
   */
  static getEvents(ledgerId, limit = 1000) {
    return db.prepare(`
      SELECT * FROM run_events
      WHERE ledger_id = ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(ledgerId, limit);
  }
  
  /**
   * Get events since a specific sequence number
   */
  static getEventsSince(ledgerId, sinceSeq) {
    return db.prepare(`
      SELECT * FROM run_events
      WHERE ledger_id = ? AND seq > ?
      ORDER BY seq ASC
    `).all(ledgerId, sinceSeq);
  }
  
  /**
   * Check if a side effect has already been applied
   */
  static hasSideEffect(ledgerId, sideEffectKey) {
    const row = db.prepare(`
      SELECT id FROM run_events
      WHERE ledger_id = ? AND side_effect_key = ? AND status = ?
      LIMIT 1
    `).get(ledgerId, sideEffectKey, EVENT_STATUS.RECORDED);
    
    return !!row;
  }
  
  /**
   * Update run status
   */
  static updateStatus(ledgerId, status) {
    db.prepare('UPDATE run_ledgers SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), ledgerId);
  }
  
  /**
   * Update current step
   */
  static updateCurrentStep(ledgerId, stepName) {
    db.prepare('UPDATE run_ledgers SET current_step = ?, updated_at = ? WHERE id = ?')
      .run(stepName, Date.now(), ledgerId);
  }
  
  /**
   * Set last safe event
   */
  static setLastSafeEvent(ledgerId, eventId) {
    db.prepare('UPDATE run_ledgers SET last_safe_event_id = ?, updated_at = ? WHERE id = ?')
      .run(eventId, Date.now(), ledgerId);
  }
  
  /**
   * Set replay boundary
   */
  static setReplayBoundary(ledgerId, eventId) {
    db.prepare('UPDATE run_ledgers SET replay_boundary_event_id = ?, updated_at = ? WHERE id = ?')
      .run(eventId, Date.now(), ledgerId);
  }
  
  /**
   * Block capabilities for this run
   */
  static blockCapabilities(ledgerId, capabilities) {
    const existing = this.getLedger(ledgerId);
    const current = existing.blocked_capabilities_json ? JSON.parse(existing.blocked_capabilities_json) : [];
    const updated = [...new Set([...current, ...capabilities])];
    
    db.prepare('UPDATE run_ledgers SET blocked_capabilities_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(updated), Date.now(), ledgerId);
  }
  
  /**
   * Create an artifact record
   */
  static createArtifact({ ledgerId, eventId = null, artifactType, uriOrPath, contentHash = null, metadata = {} }) {
    const artifactId = generateId('art');
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO run_artifacts (id, ledger_id, event_id, artifact_type, uri_or_path, content_hash, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(artifactId, ledgerId, eventId, artifactType, uriOrPath, contentHash, JSON.stringify(metadata), now);
    
    return { artifactId, uriOrPath, createdAt: now };
  }
  
  /**
   * Get all artifacts for a run
   */
  static getArtifacts(ledgerId) {
    return db.prepare('SELECT * FROM run_artifacts WHERE ledger_id = ? ORDER BY created_at ASC').all(ledgerId);
  }
}

module.exports = RunLedger;
