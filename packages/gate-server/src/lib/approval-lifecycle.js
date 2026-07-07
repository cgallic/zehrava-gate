const db = require('./db');
const { logEvent } = require('./audit');

// A2H-style interaction states for the approval request itself, tracked
// separately from the intent's own status (pending_approval | approved | ...)
// so callers can distinguish "not delivered yet" from "delivered, no answer
// yet" from "answered" without overloading intent status.
const APPROVAL_STATES = {
  PENDING: 'pending',
  SENT: 'sent',
  WAITING_INPUT: 'waiting_input',
  ANSWERED: 'answered',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

const TERMINAL_STATES = new Set([
  APPROVAL_STATES.ANSWERED,
  APPROVAL_STATES.EXPIRED,
  APPROVAL_STATES.CANCELLED,
  APPROVAL_STATES.FAILED,
]);

const ALLOWED_TRANSITIONS = {
  [APPROVAL_STATES.PENDING]: [APPROVAL_STATES.SENT, APPROVAL_STATES.FAILED, APPROVAL_STATES.CANCELLED],
  [APPROVAL_STATES.SENT]: [APPROVAL_STATES.WAITING_INPUT, APPROVAL_STATES.FAILED, APPROVAL_STATES.EXPIRED, APPROVAL_STATES.CANCELLED],
  [APPROVAL_STATES.WAITING_INPUT]: [APPROVAL_STATES.ANSWERED, APPROVAL_STATES.EXPIRED, APPROVAL_STATES.CANCELLED, APPROVAL_STATES.FAILED],
};

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * Move a proposal's approval_state forward. Returns { ok, reason, previous, next }.
 * Refuses transitions out of a terminal state (answered/expired/cancelled/failed
 * can never be re-opened) and refuses transitions not on the allow-list.
 */
function transitionApprovalState(proposalId, nextState, { actor = 'system', reason } = {}) {
  const proposal = db.prepare('SELECT id, approval_state FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return { ok: false, reason: 'intent_not_found' };

  const current = proposal.approval_state || APPROVAL_STATES.PENDING;
  if (current === nextState) return { ok: true, previous: current, next: nextState, noop: true };

  if (isTerminal(current)) {
    return { ok: false, reason: 'approval_interaction_terminal', previous: current, next: nextState };
  }
  const allowed = ALLOWED_TRANSITIONS[current] || [];
  if (!allowed.includes(nextState)) {
    return { ok: false, reason: 'invalid_transition', previous: current, next: nextState };
  }

  db.prepare('UPDATE proposals SET approval_state = ? WHERE id = ?').run(nextState, proposalId);
  logEvent(proposalId, 'approval_state_changed', actor, { previous: current, next: nextState, reason: reason || null });
  return { ok: true, previous: current, next: nextState };
}

module.exports = { APPROVAL_STATES, TERMINAL_STATES, ALLOWED_TRANSITIONS, isTerminal, transitionApprovalState };
