'use strict';

const { GateBlockedError, GatePendingError, GateTimeoutError } = require('./errors');

/**
 * GateTool wraps any LangChain Tool with Zehrava Gate governance.
 *
 * Every call goes through Gate first:
 *   - approved  → calls the original tool and returns its output
 *   - blocked   → throws GateBlockedError (or calls onBlocked)
 *   - pending   → polls until approved, timeout, or rejected
 *
 * @example
 * const governed = new GateTool({
 *   tool: emailTool,
 *   gate,
 *   policy: 'outbound-email',
 *   destination: 'sendgrid.send',
 * });
 * const result = await governed._call(input);
 */
class GateTool {
  /**
   * @param {object} options
   * @param {object}   options.tool          - LangChain Tool instance (must expose name, description, _call)
   * @param {object}   options.gate          - Gate SDK client (zehrava-gate)
   * @param {string}   options.policy        - Policy ID to evaluate against
   * @param {string}   options.destination   - Destination string (e.g. "sendgrid.send")
   * @param {object}   [options.toolOptions] - Extra options
   * @param {Function} [options.toolOptions.idempotencyKeyFn]  - (input) => string; derive idempotency key from input
   * @param {Function} [options.toolOptions.onBlocked]         - (intentId, reason) => any; override default throw
   * @param {Function} [options.toolOptions.onPending]         - (intentId) => void; called each poll cycle
   * @param {boolean}  [options.toolOptions.autoExecute=false] - Auto-call execute() on approval if runner_exec mode
   * @param {number}   [options.toolOptions.pollIntervalMs=5000]  - Poll interval while pending
   * @param {number}   [options.toolOptions.timeoutMs=300000]     - Max wait for approval
   */
  constructor({ tool, gate, policy, destination, toolOptions = {} }) {
    if (!tool || !gate || !policy || !destination) {
      throw new Error('GateTool requires: tool, gate, policy, destination');
    }

    this.tool = tool;
    this.gate = gate;
    this.policy = policy;
    this.destination = destination;

    this.idempotencyKeyFn = toolOptions.idempotencyKeyFn || null;
    this.onBlocked        = toolOptions.onBlocked || null;
    this.onPending        = toolOptions.onPending || null;
    this.autoExecute      = toolOptions.autoExecute || false;
    this.pollIntervalMs   = toolOptions.pollIntervalMs || 5000;
    this.timeoutMs        = toolOptions.timeoutMs || 300_000;

    // Expose LangChain Tool interface fields
    this.name        = tool.name;
    this.description = tool.description;
    this.schema      = tool.schema;
  }

  /**
   * LangChain Tool-compatible _call method.
   * Submits intent, waits for decision, proxies to underlying tool on approval.
   *
   * @param {string} input - Tool input (as string, matching LangChain Tool interface)
   * @returns {Promise<string>} - Tool output
   */
  async _call(input) {
    const idempotencyKey = this.idempotencyKeyFn
      ? this.idempotencyKeyFn(input)
      : null;

    // 1. Submit intent
    let intent;
    try {
      intent = await this.gate.propose({
        payload: typeof input === 'string' ? input : JSON.stringify(input),
        destination: this.destination,
        policy: this.policy,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        metadata: { source: 'langchain', tool: this.tool.name },
      });
    } catch (err) {
      throw new Error(`Gate submission failed: ${err.message}`);
    }

    const intentId = intent.intentId || intent.proposalId;

    // 2. Handle immediate decision
    if (intent.status === 'blocked' || intent.status === 'duplicate_blocked') {
      return this._handleBlocked(intentId, intent.blockReason || intent.reason || 'blocked by policy');
    }

    if (intent.status === 'approved') {
      return this._run(intentId, input);
    }

    if (intent.status === 'pending_approval') {
      return this._pollUntilApproved(intentId, input);
    }

    throw new Error(`Unexpected Gate status: ${intent.status}`);
  }

  /** @private */
  async _pollUntilApproved(intentId, input) {
    const deadline = Date.now() + this.timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      await _sleep(this.pollIntervalMs);
      pollCount++;

      let fetched;
      try {
        fetched = await this.gate.getIntent(intentId);
      } catch (e) {
        // Gate unreachable — abort
        throw new Error(`Gate unreachable while polling ${intentId}: ${e.message}`);
      }

      const status = fetched.status;

      if (typeof this.onPending === 'function') {
        this.onPending(intentId, status, pollCount);
      }

      if (status === 'approved') {
        return this._run(intentId, input);
      }

      if (status === 'blocked' || status === 'duplicate_blocked' || status === 'expired') {
        return this._handleBlocked(intentId, fetched.blockReason || status);
      }

      // Still pending — keep polling
    }

    throw new GateTimeoutError(intentId, this.timeoutMs);
  }

  /** @private */
  async _run(intentId, input) {
    // Call the underlying tool
    const result = await this.tool._call(input);

    // Optionally report execution result back to Gate
    if (this.autoExecute) {
      try {
        const exe = await this.gate.execute(intentId);
        const exeId = exe.executionId;
        await this.gate.reportExecution(exeId, {
          status: 'succeeded',
          metadata: { tool: this.tool.name },
        });
      } catch {
        // Non-fatal — tool already ran
      }
    }

    return result;
  }

  /** @private */
  _handleBlocked(intentId, reason) {
    if (typeof this.onBlocked === 'function') {
      return this.onBlocked(intentId, reason);
    }
    throw new GateBlockedError(intentId, reason);
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { GateTool };
