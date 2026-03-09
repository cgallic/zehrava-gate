'use strict';

/**
 * Thrown when Gate blocks an intent (policy violation, rate limit, etc.)
 */
class GateBlockedError extends Error {
  constructor(intentId, blockReason) {
    super(`Gate blocked intent ${intentId}: ${blockReason}`);
    this.name = 'GateBlockedError';
    this.intentId = intentId;
    this.blockReason = blockReason;
  }
}

/**
 * Thrown when an intent is still pending after timeout.
 */
class GatePendingError extends Error {
  constructor(intentId) {
    super(`Gate intent ${intentId} is still pending approval`);
    this.name = 'GatePendingError';
    this.intentId = intentId;
  }
}

/**
 * Thrown when polling for approval exceeds timeoutMs.
 */
class GateTimeoutError extends Error {
  constructor(intentId, timeoutMs) {
    super(`Gate intent ${intentId} not approved within ${timeoutMs}ms`);
    this.name = 'GateTimeoutError';
    this.intentId = intentId;
    this.timeoutMs = timeoutMs;
  }
}

module.exports = { GateBlockedError, GatePendingError, GateTimeoutError };
