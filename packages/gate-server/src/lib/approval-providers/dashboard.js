// The default, local-only approval channel. Approvals happen directly in
// Gate's own dashboard/API, so there's nothing external to dispatch to or
// verify — this exists mainly so callers can treat "dashboard" as just
// another provider rather than a special case.
module.exports = {
  name: 'dashboard',

  async sendAuthorize(intent, approvalRequest) {
    return { interactionId: intent.id, messageId: approvalRequest.messageId, state: 'waiting_input' };
  },

  async getStatus() {
    return { state: 'unknown', note: 'dashboard provider has no external status — read the intent directly' };
  },

  async cancel() {
    return { cancelled: true };
  },

  async verifyResponse() {
    return { valid: true, note: 'dashboard decisions are captured directly by Gate — nothing external to verify' };
  },
};
