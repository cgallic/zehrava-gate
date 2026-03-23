/**
 * Run Ledger constants - event types, side effect classes, and status values
 */

// Event types that can be recorded in run_events
const EVENT_TYPES = {
  RUN_STARTED: 'run_started',
  PLAN_LOCKED: 'plan_locked',
  TOOL_CALL_STARTED: 'tool_call_started',
  TOOL_CALL_FINISHED: 'tool_call_finished',
  ARTIFACT_CREATED: 'artifact_created',
  INTENT_PROPOSED: 'intent_proposed',
  POLICY_CHECKED: 'policy_checked',
  APPROVAL_REQUESTED: 'approval_requested',
  APPROVAL_RECEIVED: 'approval_received',
  EXECUTION_REQUESTED: 'execution_requested',
  EXECUTION_SUCCEEDED: 'execution_succeeded',
  DELEGATION_STARTED: 'delegation_started',
  DELEGATION_FINISHED: 'delegation_finished',
  CHECKPOINT_SEALED: 'checkpoint_sealed',
  INTERRUPTION_DETECTED: 'interruption_detected',
  RUN_RESUMED: 'run_resumed',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed'
};

// Events that count as real progress (not just chatter)
const PROGRESS_EVENTS = new Set([
  EVENT_TYPES.PLAN_LOCKED,
  EVENT_TYPES.TOOL_CALL_FINISHED,
  EVENT_TYPES.ARTIFACT_CREATED,
  EVENT_TYPES.POLICY_CHECKED,
  EVENT_TYPES.APPROVAL_RECEIVED,
  EVENT_TYPES.EXECUTION_SUCCEEDED,
  EVENT_TYPES.DELEGATION_FINISHED,
  EVENT_TYPES.RUN_COMPLETED
]);

// Side effect classifications
const SIDE_EFFECT_CLASS = {
  NONE: 'none',
  READ: 'read',
  WRITE: 'write',
  EXTERNAL_MUTATION: 'external_mutation',
  PAYMENT: 'payment',
  NOTIFICATION: 'notification',
  DELEGATION: 'delegation'
};

// Side effects that must not be auto-replayed on resume
const NON_REPLAYABLE_SIDE_EFFECTS = new Set([
  SIDE_EFFECT_CLASS.EXTERNAL_MUTATION,
  SIDE_EFFECT_CLASS.PAYMENT,
  SIDE_EFFECT_CLASS.NOTIFICATION
]);

// Run statuses
const RUN_STATUS = {
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required'
};

// Event statuses
const EVENT_STATUS = {
  RECORDED: 'recorded',
  REPLAYED: 'replayed',
  SKIPPED: 'skipped'
};

// Checkpoint reasons
const CHECKPOINT_REASON = {
  INTERRUPTION: 'interruption',
  FAILURE: 'failure',
  APPROVAL_REQUESTED: 'approval_requested',
  EXPLICIT_HANDOFF: 'explicit_handoff',
  PERIODIC_SAFETY: 'periodic_safety',
  RISKY_BOUNDARY: 'risky_boundary'
};

// Handoff types
const HANDOFF_TYPE = {
  APPROVAL: 'approval',
  DELEGATION: 'delegation',
  MANUAL: 'manual'
};

module.exports = {
  EVENT_TYPES,
  PROGRESS_EVENTS,
  SIDE_EFFECT_CLASS,
  NON_REPLAYABLE_SIDE_EFFECTS,
  RUN_STATUS,
  EVENT_STATUS,
  CHECKPOINT_REASON,
  HANDOFF_TYPE
};
