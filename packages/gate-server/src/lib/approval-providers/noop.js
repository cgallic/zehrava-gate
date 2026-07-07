// A provider that dispatches nowhere — useful for tests and demos that
// need to exercise policy-driven provider routing without touching a real
// external channel.
module.exports = {
  name: 'noop',

  async sendAuthorize(intent, approvalRequest) {
    return { interactionId: intent.id, messageId: approvalRequest.messageId, state: 'sent', note: 'noop provider — no dispatch performed' };
  },

  async getStatus() {
    return { state: 'unknown' };
  },

  async cancel() {
    return { cancelled: true };
  },

  async verifyResponse() {
    return { valid: true };
  },
};
