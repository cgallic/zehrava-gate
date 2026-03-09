'use strict';

/**
 * LangGraph StateGraph integration helpers.
 *
 * These helpers let you route agent graph edges based on Gate intent status —
 * so you can build graphs that pause on "pending", halt on "blocked",
 * and proceed on "approved" without hand-rolling the conditional logic.
 */

/**
 * Returns a conditional edge function for LangGraph StateGraph.
 *
 * Usage:
 *   graph.addConditionalEdges('check_gate', gateRouteAfter('gateStatus'), {
 *     execute:  'run_tool',
 *     blocked:  'handle_blocked',
 *     pending:  'wait_for_approval',
 *     __end__:  END,
 *   });
 *
 * @param {string} statusField - Key in graph state that holds the Gate intent status
 * @returns {function(state): string}
 */
function gateRouteAfter(statusField) {
  return (state) => {
    const status = state[statusField];
    if (status === 'approved')              return 'execute';
    if (status === 'blocked')               return 'blocked';
    if (status === 'duplicate_blocked')     return 'blocked';
    if (status === 'pending_approval')      return 'pending';
    return '__end__';
  };
}

/**
 * Build a Gate-aware node for LangGraph.
 *
 * The node submits an intent and writes the result into state fields.
 * Combine with gateRouteAfter() to branch the graph based on Gate's decision.
 *
 * @param {object}   options
 * @param {object}   options.gate           - Gate SDK client
 * @param {Function} options.buildIntent    - (state) => { payload, destination, policy, ... }
 * @param {string}   [options.intentField]  - State key to write intentId into (default: 'gateIntentId')
 * @param {string}   [options.statusField]  - State key to write status into (default: 'gateStatus')
 * @returns {function(state): Promise<Partial<state>>}
 */
function gateNode({ gate, buildIntent, intentField = 'gateIntentId', statusField = 'gateStatus' }) {
  return async (state) => {
    const intentBody = buildIntent(state);
    const intent = await gate.propose(intentBody);
    const intentId = intent.intentId || intent.proposalId;
    return {
      [intentField]: intentId,
      [statusField]: intent.status,
      gateBlockReason: intent.blockReason || null,
    };
  };
}

module.exports = { gateRouteAfter, gateNode };
