/**
 * Resume Resolver - handles safe resumption from checkpoints
 */

const db = require('../db');
const { generateId } = require('../crypto');
const RunLedger = require('./ledger');
const CheckpointSealer = require('./checkpoint');
const { EVENT_TYPES, RUN_STATUS, NON_REPLAYABLE_SIDE_EFFECTS } = require('./constants');

class ResumeResolver {
  /**
   * Resume a run from its latest valid checkpoint
   */
  static resume(runId, { fromCheckpointId = null } = {}) {
    const ledger = RunLedger.getRun(runId);
    if (!ledger) throw new Error(`Run not found: ${runId}`);
    
    // Get checkpoint to resume from
    const checkpoint = fromCheckpointId
      ? db.prepare('SELECT * FROM run_checkpoints WHERE id = ?').get(fromCheckpointId)
      : CheckpointSealer.getLatest(ledger.id);
    
    if (!checkpoint) throw new Error(`No checkpoint found for run: ${runId}`);
    if (!checkpoint.is_resumable) throw new Error(`Checkpoint is not resumable: ${checkpoint.id}`);
    
    // Verify checkpoint integrity
    const verification = CheckpointSealer.verify(checkpoint.id);
    if (!verification.valid) {
      // Mark run as requiring manual review
      RunLedger.updateStatus(ledger.id, RUN_STATUS.MANUAL_REVIEW_REQUIRED);
      throw new Error(`Checkpoint verification failed: ${verification.reason}`);
    }
    
    // Parse resume packet
    const resumePacket = JSON.parse(checkpoint.resume_packet_json);
    
    // Build resume context
    const resumeContext = this.buildResumeContext(ledger, resumePacket, checkpoint);
    
    // Record run_resumed event
    RunLedger.recordEvent({
      ledgerId: ledger.id,
      eventType: EVENT_TYPES.RUN_RESUMED,
      payload: {
        checkpointId: checkpoint.id,
        fromEventId: checkpoint.event_id,
        resumeContext: {
          receiptsCount: resumePacket.receipts.length,
          artifactsCount: resumePacket.artifacts.length,
          unresolvedApprovalsCount: resumePacket.unresolvedApprovals.length,
          blockedSideEffectsCount: resumePacket.nonReplayableSideEffects.length
        }
      }
    });
    
    // Update run status back to active
    RunLedger.updateStatus(ledger.id, RUN_STATUS.ACTIVE);
    
    return resumeContext;
  }
  
  /**
   * Build context for resuming execution
   */
  static buildResumeContext(ledger, resumePacket, checkpoint) {
    return {
      runId: resumePacket.runId,
      ledgerId: resumePacket.ledgerId,
      checkpointId: checkpoint.id,
      runtime: resumePacket.originatingRuntime,
      agentId: resumePacket.originatingAgent,
      intentSummary: resumePacket.intentSummary,
      currentStep: resumePacket.currentStep,
      
      // What happened before
      receipts: resumePacket.receipts,
      artifacts: resumePacket.artifacts,
      
      // What needs attention
      unresolvedApprovals: resumePacket.unresolvedApprovals,
      
      // What's still allowed
      remainingPermissions: resumePacket.remainingPermissions,
      blockedCapabilities: resumePacket.blockedCapabilities,
      
      // What must not be repeated
      nonReplayableSideEffects: resumePacket.nonReplayableSideEffects,
      blockedSideEffectKeys: new Set(resumePacket.nonReplayableSideEffects.map(e => e.key)),
      
      // Where to go next
      suggestedNextAction: resumePacket.suggestedNextAction,
      
      // Metadata
      resumedAt: Date.now(),
      schemaVersion: resumePacket.schemaVersion
    };
  }
  
  /**
   * Check if an action should be skipped due to prior side effect
   */
  static shouldSkipDueToSideEffect(ledgerId, sideEffectKey) {
    return RunLedger.hasSideEffect(ledgerId, sideEffectKey);
  }
  
  /**
   * Get all resumable checkpoints for a run
   */
  static getResumableCheckpoints(runId) {
    const ledger = RunLedger.getRun(runId);
    if (!ledger) return [];
    
    const checkpoints = db.prepare(`
      SELECT * FROM run_checkpoints
      WHERE ledger_id = ? AND is_resumable = 1
      ORDER BY created_at DESC
    `).all(ledger.id);
    
    // Verify each checkpoint
    return checkpoints.map(cp => {
      const verification = CheckpointSealer.verify(cp.id);
      return {
        checkpointId: cp.id,
        reason: cp.checkpoint_reason,
        createdAt: cp.created_at,
        valid: verification.valid,
        verificationReason: verification.reason
      };
    });
  }
  
  /**
   * Create a handoff for approval or delegation
   */
  static createHandoff({ ledgerId, checkpointId, fromActor, toActor, handoffType, summary }) {
    const handoffId = generateId('ho');
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO run_handoffs (id, ledger_id, checkpoint_id, from_actor, to_actor, handoff_type, handoff_summary, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(handoffId, ledgerId, checkpointId, fromActor, toActor, handoffType, summary, now);
    
    return { handoffId, createdAt: now };
  }
  
  /**
   * Complete a handoff
   */
  static completeHandoff(handoffId) {
    db.prepare('UPDATE run_handoffs SET status = ? WHERE id = ?').run('completed', handoffId);
  }
}

module.exports = ResumeResolver;
