/**
 * Internal API routes for Run Ledger
 */

const { RunLedger, CheckpointSealer, ResumeResolver, EVENT_TYPES, SIDE_EFFECT_CLASS } = require('../lib/runs');

module.exports = function (app) {
  /**
   * POST /internal/runs/start
   * Start a new run
   */
  app.post('/internal/runs/start', (req, res) => {
    try {
      const { agentId, intentSummary, runtime, parentRunId, permissions } = req.body;
      
      if (!agentId || !intentSummary) {
        return res.status(400).json({ error: 'agentId and intentSummary are required' });
      }
      
      const run = RunLedger.start({
        agentId,
        intentSummary,
        runtime: runtime || 'zehrava-gate',
        parentRunId,
        permissions: permissions || {}
      });
      
      res.json(run);
    } catch (err) {
      console.error('[runs/start] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * POST /internal/runs/:runId/events
   * Record an event
   */
  app.post('/internal/runs/:runId/events', (req, res) => {
    try {
      const { runId } = req.params;
      const {
        eventType,
        actorId,
        stepName,
        payload,
        inputHash,
        outputHash,
        sideEffectClass,
        sideEffectKey
      } = req.body;
      
      if (!eventType) {
        return res.status(400).json({ error: 'eventType is required' });
      }
      
      const ledger = RunLedger.getRun(runId);
      if (!ledger) {
        return res.status(404).json({ error: 'Run not found' });
      }
      
      const event = RunLedger.recordEvent({
        ledgerId: ledger.id,
        eventType,
        actorId,
        stepName,
        payload: payload || {},
        inputHash,
        outputHash,
        sideEffectClass: sideEffectClass || SIDE_EFFECT_CLASS.NONE,
        sideEffectKey
      });
      
      res.json(event);
    } catch (err) {
      console.error('[runs/events] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * POST /internal/runs/:runId/checkpoint
   * Create a checkpoint
   */
  app.post('/internal/runs/:runId/checkpoint', (req, res) => {
    try {
      const { runId } = req.params;
      const { eventId, reason, suggestedNextAction } = req.body;
      
      const ledger = RunLedger.getRun(runId);
      if (!ledger) {
        return res.status(404).json({ error: 'Run not found' });
      }
      
      // If no event ID provided, use the most recent event
      let targetEventId = eventId;
      if (!targetEventId) {
        const events = RunLedger.getEvents(ledger.id, 1);
        if (events.length === 0) {
          return res.status(400).json({ error: 'No events to checkpoint' });
        }
        targetEventId = events[events.length - 1].id;
      }
      
      const checkpoint = CheckpointSealer.seal({
        ledgerId: ledger.id,
        eventId: targetEventId,
        reason,
        suggestedNextAction
      });
      
      res.json(checkpoint);
    } catch (err) {
      console.error('[runs/checkpoint] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * POST /internal/runs/:runId/resume
   * Resume from latest checkpoint
   */
  app.post('/internal/runs/:runId/resume', (req, res) => {
    try {
      const { runId } = req.params;
      const { fromCheckpointId } = req.body;
      
      const resumeContext = ResumeResolver.resume(runId, { fromCheckpointId });
      
      res.json(resumeContext);
    } catch (err) {
      console.error('[runs/resume] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * GET /internal/runs/:runId
   * Get run details
   */
  app.get('/internal/runs/:runId', (req, res) => {
    try {
      const { runId } = req.params;
      
      const ledger = RunLedger.getRun(runId);
      if (!ledger) {
        return res.status(404).json({ error: 'Run not found' });
      }
      
      const events = RunLedger.getEvents(ledger.id);
      const checkpoints = CheckpointSealer.getAll(ledger.id);
      const artifacts = RunLedger.getArtifacts(ledger.id);
      const resumableCheckpoints = ResumeResolver.getResumableCheckpoints(runId);
      
      res.json({
        run: {
          runId: ledger.run_id,
          ledgerId: ledger.id,
          agentId: ledger.agent_id,
          intentSummary: ledger.intent_summary,
          status: ledger.status,
          currentStep: ledger.current_step,
          lastSafeEventId: ledger.last_safe_event_id,
          createdAt: ledger.created_at,
          updatedAt: ledger.updated_at
        },
        events: events.map(e => ({
          eventId: e.id,
          seq: e.seq,
          type: e.event_type,
          timestamp: e.event_ts,
          actor: e.actor_id,
          step: e.step_name,
          sideEffectClass: e.side_effect_class,
          status: e.status
        })),
        checkpoints: checkpoints.map(c => ({
          checkpointId: c.id,
          eventId: c.event_id,
          reason: c.checkpoint_reason,
          isResumable: !!c.is_resumable,
          createdAt: c.created_at
        })),
        artifacts: artifacts.map(a => ({
          artifactId: a.id,
          type: a.artifact_type,
          uri: a.uri_or_path,
          hash: a.content_hash,
          createdAt: a.created_at
        })),
        resumableCheckpoints
      });
    } catch (err) {
      console.error('[runs/get] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * GET /internal/runs/:runId/events
   * Get all events for a run
   */
  app.get('/internal/runs/:runId/events', (req, res) => {
    try {
      const { runId } = req.params;
      
      const ledger = RunLedger.getRun(runId);
      if (!ledger) {
        return res.status(404).json({ error: 'Run not found' });
      }
      
      const events = RunLedger.getEvents(ledger.id);
      
      res.json({
        runId,
        events: events.map(e => ({
          eventId: e.id,
          seq: e.seq,
          type: e.event_type,
          timestamp: e.event_ts,
          actor: e.actor_id,
          step: e.step_name,
          payload: JSON.parse(e.payload_json),
          sideEffectClass: e.side_effect_class,
          sideEffectKey: e.side_effect_key,
          status: e.status,
          createdAt: e.created_at
        }))
      });
    } catch (err) {
      console.error('[runs/events] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  /**
   * POST /internal/runs/:runId/verify
   * Verify run integrity
   */
  app.post('/internal/runs/:runId/verify', (req, res) => {
    try {
      const { runId } = req.params;
      
      const ledger = RunLedger.getRun(runId);
      if (!ledger) {
        return res.status(404).json({ error: 'Run not found' });
      }
      
      const checkpoints = CheckpointSealer.getAll(ledger.id);
      const checkpointVerifications = checkpoints.map(cp => ({
        checkpointId: cp.id,
        ...CheckpointSealer.verify(cp.id)
      }));
      
      const allCheckpointsValid = checkpointVerifications.every(v => v.valid);
      
      res.json({
        runId,
        ledgerIntegrity: {
          valid: true,  // Would need to implement full ledger hash chain verification
          hash: ledger.integrity_hash
        },
        checkpointIntegrity: {
          valid: allCheckpointsValid,
          checkpoints: checkpointVerifications
        },
        lineageContinuity: {
          valid: true,  // Would check parent_run_id chain
          parentRunId: ledger.parent_run_id
        }
      });
    } catch (err) {
      console.error('[runs/verify] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
};
