/**
 * Checkpoint Sealer - creates sealed resumable checkpoints at safe boundaries
 */

const db = require('../db');
const { generateId } = require('../crypto');
const RunLedger = require('./ledger');
const { checkpointSealedHash } = require('./hash');
const { CHECKPOINT_REASON, EVENT_TYPES, PROGRESS_EVENTS, NON_REPLAYABLE_SIDE_EFFECTS } = require('./constants');

class CheckpointSealer {
  /**
   * Create a checkpoint at the current run state
   */
  static seal({ ledgerId, eventId, reason, suggestedNextAction = null }) {
    const ledger = RunLedger.getLedger(ledgerId);
    if (!ledger) throw new Error(`Ledger not found: ${ledgerId}`);
    
    const events = RunLedger.getEvents(ledgerId);
    const currentEvent = events.find(e => e.id === eventId);
    if (!currentEvent) throw new Error(`Event not found: ${eventId}`);
    
    // Build resume packet
    const resumePacket = this.buildResumePacket(ledger, events, currentEvent, suggestedNextAction);
    
    // Compute sealed hash
    const checkpointId = generateId('ckpt');
    const sealedHash = checkpointSealedHash(checkpointId, ledgerId, eventId, resumePacket, events);
    
    // Check if resumable (has all required data)
    const isResumable = this.isResumable(resumePacket);
    
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO run_checkpoints (id, ledger_id, event_id, checkpoint_reason, resume_packet_json, sealed_hash, is_resumable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      ledgerId,
      eventId,
      reason,
      JSON.stringify(resumePacket),
      sealedHash,
      isResumable ? 1 : 0,
      now
    );
    
    // Record checkpoint event
    RunLedger.recordEvent({
      ledgerId,
      eventType: EVENT_TYPES.CHECKPOINT_SEALED,
      payload: { checkpointId, reason, isResumable }
    });
    
    return {
      checkpointId,
      sealedHash,
      isResumable,
      reason,
      createdAt: now
    };
  }
  
  /**
   * Build a resume packet from current run state
   */
  static buildResumePacket(ledger, events, currentEvent, suggestedNextAction) {
    // Filter events to only those that represent real progress
    const progressEvents = events.filter(e => PROGRESS_EVENTS.has(e.event_type));
    
    // Find replay boundary (last major progress point)
    const replayBoundaryEvent = ledger.replay_boundary_event_id 
      ? events.find(e => e.id === ledger.replay_boundary_event_id)
      : progressEvents[Math.max(0, progressEvents.length - 1)];
    
    const replayBoundarySeq = replayBoundaryEvent ? replayBoundaryEvent.seq : 0;
    
    // Get receipts since replay boundary
    const receipts = events
      .filter(e => e.seq > replayBoundarySeq)
      .map(e => ({
        eventId: e.id,
        seq: e.seq,
        type: e.event_type,
        timestamp: e.event_ts,
        actor: e.actor_id,
        step: e.step_name,
        sideEffectClass: e.side_effect_class,
        sideEffectKey: e.side_effect_key
      }));
    
    // Collect side effects that must not be repeated
    const nonReplayableSideEffects = events
      .filter(e => NON_REPLAYABLE_SIDE_EFFECTS.has(e.side_effect_class) && e.side_effect_key)
      .map(e => ({
        key: e.side_effect_key,
        type: e.event_type,
        eventId: e.id
      }));
    
    // Get open artifacts
    const artifacts = RunLedger.getArtifacts(ledger.id).map(a => ({
      artifactId: a.id,
      type: a.artifact_type,
      uri: a.uri_or_path,
      hash: a.content_hash
    }));
    
    // Find unresolved approvals (approval_requested without corresponding approval_received)
    const approvalRequests = events.filter(e => e.event_type === EVENT_TYPES.APPROVAL_REQUESTED);
    const approvalReceived = new Set(events.filter(e => e.event_type === EVENT_TYPES.APPROVAL_RECEIVED).map(e => {
      const payload = JSON.parse(e.payload_json);
      return payload.intentId || payload.requestId;
    }));
    
    const unresolvedApprovals = approvalRequests
      .filter(e => {
        const payload = JSON.parse(e.payload_json);
        const requestId = payload.intentId || payload.requestId;
        return !approvalReceived.has(requestId);
      })
      .map(e => ({
        eventId: e.id,
        payload: JSON.parse(e.payload_json)
      }));
    
    return {
      runId: ledger.run_id,
      ledgerId: ledger.id,
      checkpointEventId: currentEvent.id,
      originatingRuntime: ledger.runtime,
      originatingAgent: ledger.agent_id,
      intentSummary: ledger.intent_summary,
      currentStep: ledger.current_step,
      lastSafeEventId: ledger.last_safe_event_id,
      replayBoundaryEventId: replayBoundaryEvent ? replayBoundaryEvent.id : null,
      replayBoundarySeq: replayBoundarySeq,
      receipts,
      artifacts,
      unresolvedApprovals,
      remainingPermissions: JSON.parse(ledger.permissions_json || '{}'),
      blockedCapabilities: JSON.parse(ledger.blocked_capabilities_json || '[]'),
      nonReplayableSideEffects,
      suggestedNextAction,
      schemaVersion: ledger.schema_version
    };
  }
  
  /**
   * Check if a resume packet has all required data to be resumable
   */
  static isResumable(resumePacket) {
    return !!(
      resumePacket.runId &&
      resumePacket.ledgerId &&
      resumePacket.originatingAgent &&
      resumePacket.intentSummary &&
      resumePacket.schemaVersion
    );
  }
  
  /**
   * Get latest checkpoint for a run
   */
  static getLatest(ledgerId) {
    return db.prepare(`
      SELECT * FROM run_checkpoints
      WHERE ledger_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(ledgerId);
  }
  
  /**
   * Get all checkpoints for a run
   */
  static getAll(ledgerId) {
    return db.prepare(`
      SELECT * FROM run_checkpoints
      WHERE ledger_id = ?
      ORDER BY created_at ASC
    `).all(ledgerId);
  }
  
  /**
   * Verify checkpoint integrity
   */
  static verify(checkpointId) {
    const checkpoint = db.prepare('SELECT * FROM run_checkpoints WHERE id = ?').get(checkpointId);
    if (!checkpoint) return { valid: false, reason: 'checkpoint_not_found' };
    
    const ledger = RunLedger.getLedger(checkpoint.ledger_id);
    if (!ledger) return { valid: false, reason: 'ledger_not_found' };
    
    const allEvents = RunLedger.getEvents(checkpoint.ledger_id);
    
    // Get the checkpoint event to find its sequence number
    const checkpointEvent = allEvents.find(e => e.id === checkpoint.event_id);
    if (!checkpointEvent) return { valid: false, reason: 'checkpoint_event_not_found' };
    
    // Only include events up to and including the checkpoint event
    // (seal() may have recorded a CHECKPOINT_SEALED event after computing the hash)
    const events = allEvents.filter(e => e.seq <= checkpointEvent.seq);
    
    const resumePacket = JSON.parse(checkpoint.resume_packet_json);
    
    // Recompute sealed hash using the same event set that was used during seal
    const computedHash = checkpointSealedHash(
      checkpointId,
      checkpoint.ledger_id,
      checkpoint.event_id,
      resumePacket,
      events
    );
    
    if (computedHash !== checkpoint.sealed_hash) {
      return { valid: false, reason: 'hash_mismatch', expected: checkpoint.sealed_hash, computed: computedHash };
    }
    
    return { valid: true };
  }
}

module.exports = CheckpointSealer;
