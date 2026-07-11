/**
 * A2H/Ola bridge provider (issue #7) — unlike kaicalls' notify-only
 * channel, this is a provider whose external gateway itself issues a
 * signed AUTHORIZE/RESPONSE decision. Gate sends AUTHORIZE to the
 * gateway; the gateway is expected to call back
 * POST /v1/approval-callbacks/a2h with a signed RESPONSE, verified
 * generically by lib/provider-signature.js + the shared callback route
 * (issue #14) — this module never trusts a decision beyond what that
 * verifier already checks (signature, delivery-ID replay, responds_to,
 * canonical intent hash, expiry, required evidence factors).
 *
 * Configure via policy YAML:
 *   approval_channel:
 *     provider: a2h
 *     a2h:
 *       gateway_url: "https://a2h.example.com/v1/authorize"  # required
 *       gateway_id: "ola-prod"                                # optional, informational
 *
 * Wire real credentials via A2H_GATEWAY_API_KEY (outbound auth to the
 * gateway) and GATE_PROVIDER_SECRET_A2H (inbound callback verification).
 * Until A2H_GATEWAY_API_KEY is set, every AUTHORIZE call is logged and
 * returned as a stub — nothing is sent to a real gateway.
 */

function isConfigured() {
  return !!process.env.A2H_GATEWAY_API_KEY;
}

function stubResult(kind, body) {
  console.log(`[a2h-provider] STUB (A2H_GATEWAY_API_KEY not set) — would ${kind}:`, JSON.stringify(body));
  return { stub: true, kind, ...body };
}

async function callGateway(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.A2H_GATEWAY_API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `A2H gateway HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const provider = {
  name: 'a2h',

  async sendAuthorize(intent, approvalRequest) {
    const channelConfig = approvalRequest.policy?.approval_channel?.a2h;
    if (!channelConfig?.gateway_url) {
      throw new Error('policy.approval_channel.a2h.gateway_url is required');
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const authorizePayload = {
      protocol: 'a2h.v1',
      message_id: approvalRequest.messageId,
      gate_approval_interaction_id: approvalRequest.approvalInteractionId || null,
      responds_to: approvalRequest.messageId,
      intent_id: intent.id,
      action: intent.action || intent.destination,
      summary: approvalRequest.summary || (intent.action || intent.destination),
      required_factors: approvalRequest.requiredFactors || [],
      expires_at: approvalRequest.expiresAt || null,
      callback_url: approvalRequest.callbackUrl || `${baseUrl}/v1/approval-callbacks/a2h`,
      gateway_id: channelConfig.gateway_id || null,
    };

    const result = isConfigured()
      ? await callGateway(channelConfig.gateway_url, authorizePayload)
      : stubResult('send_authorize', authorizePayload);

    return {
      interactionId: result.interaction_id || result.gateway_interaction_id || intent.id,
      messageId: approvalRequest.messageId,
      state: 'sent',
      gateway: result,
    };
  },

  // Best-effort only — there's no standardized A2H status-polling endpoint
  // to rely on across gateways. Gate's own approval_state (updated by the
  // verified callback, or by timeout) remains authoritative regardless.
  async getStatus() {
    if (!isConfigured()) return { state: 'unknown', note: 'a2h provider not configured — stub mode' };
    return { state: 'unknown', note: 'no generic A2H status-poll endpoint; rely on the signed callback' };
  },

  // No standardized A2H cancellation call to rely on across gateways either
  // — Gate's own POST /v1/intents/:id/cancel-approval is authoritative and
  // always works regardless of what this returns.
  async cancel() {
    return { cancelled: false, note: 'a2h gateway cancellation not implemented; Gate-side cancel-approval remains authoritative' };
  },

  // Light protocol-shape sanity check for callers that want to validate a
  // RESPONSE payload before handing it to the shared callback verifier.
  // This is NOT the trust boundary — POST /v1/approval-callbacks/a2h (#14)
  // is — it's a cheap early rejection for obviously-malformed payloads.
  async verifyResponse(response, originalMessageId) {
    if (!response || response.protocol !== 'a2h.v1') return { valid: false, reason: 'not_a2h_protocol' };
    if (!['APPROVE', 'DECLINE', 'REJECT'].includes(String(response.decision || '').toUpperCase())) {
      return { valid: false, reason: 'invalid_decision' };
    }
    if (originalMessageId && response.responds_to !== originalMessageId) {
      return { valid: false, reason: 'responds_to_mismatch' };
    }
    return { valid: true };
  },
};

module.exports = provider;
