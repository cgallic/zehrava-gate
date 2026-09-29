/**
 * A2H/Ola bridge provider (issue #7) — unlike kaicalls' notify-only
 * channel, this is a provider whose external gateway itself issues a
 * signed decision. Gate sends an A2H AUTHORIZE to the gateway (Twilio Ola,
 * the twilio-labs reference gateway, or any A2H v1.0 implementation) and
 * learns the human's answer one of two ways:
 *
 *   1. Webhook (spec §1.12): the gateway POSTs a RESPONSE to
 *      /v1/approval-callbacks/a2h signed with `X-A2H-Signature`, using the
 *      per-interaction callback secret Gate sent in the AUTHORIZE (derived
 *      from GATE_PROVIDER_SECRET_A2H and the message_id).
 *   2. Polling (spec §1.7/§1.12.9): lib/a2h-poller.js polls
 *      GET /v1/status/{interaction_id} until the interaction is terminal.
 *
 * Either way the decision goes through the same verifier as every other
 * provider (routes/approvals.js applyProviderDecision): responds_to binding,
 * canonical intent hash, expiry, required evidence factors. This module
 * never trusts a decision on its own.
 *
 * Configure via policy YAML:
 *   approval_channel:
 *     provider: a2h
 *     a2h:
 *       gateway_url: "https://gateway.example.com"  # required; base URL or /v1/intent
 *       gateway_id: "ola-prod"                        # optional, informational
 *       agent_id: "did:web:gate.example.com"          # optional; A2H_AGENT_ID env fallback
 *       principal_id: "did:example:alice"             # optional; intent's principal_id wins
 *       channel: { type: sms, address: "tel:+15551234567" }  # optional; request channel wins
 *       assurance: { level: HIGH, required_factors: [passkey.webauthn.v1] }  # optional
 *       jwks_uri: "https://gateway.example.com/.well-known/jwks.json"  # verify signed RESPONSEs
 *       require_jws: false          # true → reject RESPONSEs without a valid gateway JWS
 *       poll: true                  # poll /v1/status as a webhook fallback
 *       poll_interval_sec: 3
 *       webhook: auto               # auto (only for an https callback URL) | always | never
 *       auth: both                  # both | api_key (X-A2H-API-Key) | bearer
 *       wire_format: a2h-1.0        # or gate-legacy for pre-spec custom gateways
 *
 * Outbound auth: A2H_GATEWAY_API_KEY. Until it is set, AUTHORIZE calls are
 * logged and returned as a stub — nothing is sent to a real gateway.
 */

const {
  resolveGatewayEndpoints,
  gatewayAuthHeaders,
  buildAuthorizeMessage,
  deriveCallbackSecret,
  normalizeResponse,
  A2H_STATES,
} = require('../a2h-protocol');
const { getProviderSecret } = require('../provider-signature');

const DEFAULT_AGENT_ID = 'zehrava-gate';

function isConfigured() {
  return !!process.env.A2H_GATEWAY_API_KEY;
}

function stubResult(kind, body) {
  console.log(`[a2h-provider] STUB (A2H_GATEWAY_API_KEY not set) — would ${kind}:`, JSON.stringify(body));
  return { stub: true, kind, ...body };
}

async function callGateway(method, url, body, config = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...gatewayAuthHeaders(process.env.A2H_GATEWAY_API_KEY, config.auth || 'both'),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A2H errors are { error: { code, message } }; older gateways send a string.
    const code = json?.error?.code || null;
    const message = json?.error?.message || (typeof json?.error === 'string' ? json.error : null);
    const err = new Error(`${code ? `${code}: ` : ''}${message || `A2H gateway HTTP ${res.status}`}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return json;
}

function channelConfigFrom(policy) {
  return policy?.approval_channel?.a2h || null;
}

function ttlSecondsUntil(expiresAt) {
  if (!expiresAt) return undefined;
  const seconds = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  return Math.max(30, seconds);
}

// Pre-spec payload, kept for custom gateways built against Gate's original
// bridge contract (wire_format: gate-legacy).
function buildLegacyPayload(intent, approvalRequest, channelConfig) {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
  return {
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
}

// A2H assurance block (spec §1.3 AUTHORIZE). Only human-authentication
// factors go to the gateway — Gate's own a2h.* factors describe how Gate
// verifies the RESPONSE, which the gateway has no say in.
function a2hAssurance(approvalRequest, channelConfig) {
  if (channelConfig.assurance) return channelConfig.assurance;
  const humanFactors = (approvalRequest.requiredFactors || []).filter((f) => !String(f).startsWith('a2h.'));
  const level = approvalRequest.assuranceLevel || null;
  if (!humanFactors.length && !level) return null;
  const assurance = {};
  if (level) assurance.level = String(level).toUpperCase();
  if (humanFactors.length) assurance.required_factors = humanFactors;
  return assurance;
}

function buildSpecMessage(intent, approvalRequest, channelConfig) {
  const action = intent.action || intent.destination;
  const requestChannel = approvalRequest.channel || null;
  const configChannel = channelConfig.channel || (channelConfig.to ? { type: channelConfig.channel_type || 'sms', address: channelConfig.to } : null);
  const channel = requestChannel?.address ? { type: requestChannel.type || configChannel?.type || 'sms', address: requestChannel.address } : configChannel;

  // The callback secret is what lets Gate verify the gateway's webhook
  // (spec §1.12.4). The spec requires an HTTPS callback URL, so by default a
  // webhook is only requested when Gate's callback URL is HTTPS; otherwise
  // (or with no GATE_PROVIDER_SECRET_A2H) Gate relies on status polling.
  // webhook: always|never overrides, e.g. for a local http gateway.
  const webhookMode = channelConfig.webhook || 'auto';
  const callbackUrl = approvalRequest.callbackUrl || null;
  const wantsWebhook = webhookMode === 'always' || (webhookMode === 'auto' && /^https:\/\//i.test(callbackUrl || ''));
  const callbackSecret = wantsWebhook ? deriveCallbackSecret(getProviderSecret('a2h'), approvalRequest.messageId) : null;
  const callback = callbackSecret && callbackUrl ? { url: callbackUrl, secret: callbackSecret } : null;

  return buildAuthorizeMessage({
    messageId: approvalRequest.messageId,
    agentId: channelConfig.agent_id || process.env.A2H_AGENT_ID || DEFAULT_AGENT_ID,
    principalId: approvalRequest.principalId || channelConfig.principal_id || null,
    channel,
    render: {
      title: channelConfig.title || `Approve: ${action}`,
      body: approvalRequest.summary || `Your agent wants to run ${action}. Approve?`,
    },
    ttlSec: ttlSecondsUntil(approvalRequest.expiresAt),
    assurance: a2hAssurance(approvalRequest, channelConfig),
    explanation: approvalRequest.explanation || null,
    callback,
    params: {
      gate: {
        intent_id: intent.id,
        approval_interaction_id: approvalRequest.approvalInteractionId || null,
        action,
        destination: intent.destination || null,
        approved_intent_hash: approvalRequest.approvedIntentHash || null,
        approval_url: approvalRequest.approvalUrl || null,
        gateway_id: channelConfig.gateway_id || null,
      },
    },
  });
}

const provider = {
  name: 'a2h',

  async sendAuthorize(intent, approvalRequest) {
    const channelConfig = channelConfigFrom(approvalRequest.policy);
    if (!channelConfig?.gateway_url) {
      throw new Error('policy.approval_channel.a2h.gateway_url is required');
    }

    if (channelConfig.wire_format === 'gate-legacy') {
      const payload = buildLegacyPayload(intent, approvalRequest, channelConfig);
      const result = isConfigured()
        ? await callGateway('POST', channelConfig.gateway_url, payload, channelConfig)
        : stubResult('send_authorize', payload);
      return {
        interactionId: result.interaction_id || result.gateway_interaction_id || intent.id,
        messageId: approvalRequest.messageId,
        state: 'sent',
        poll: false,
        gateway: result,
      };
    }

    const endpoints = resolveGatewayEndpoints(channelConfig.gateway_url);
    const message = buildSpecMessage(intent, approvalRequest, channelConfig);
    if (!isConfigured()) {
      const stub = stubResult('send_authorize', { endpoint: endpoints.intent, ...message, callback: message.callback ? { url: message.callback.url, secret: '[redacted]' } : undefined });
      return { interactionId: intent.id, messageId: approvalRequest.messageId, state: 'sent', poll: false, gateway: stub };
    }

    const result = await callGateway('POST', endpoints.intent, message, channelConfig);
    if (!result.interaction_id) throw new Error('A2H gateway accepted AUTHORIZE but returned no interaction_id');
    const state = String(result.state || A2H_STATES.WAITING_INPUT).toUpperCase();
    if (state === A2H_STATES.FAILED) throw new Error('A2H gateway reported delivery FAILED');

    return {
      interactionId: result.interaction_id,
      messageId: approvalRequest.messageId,
      state: 'sent',
      gatewayState: state,
      duplicate: !!result.duplicate,
      poll: channelConfig.poll !== false,
      gateway: result,
    };
  },

  // GET /v1/status/{interaction_id} (spec §1.7). Returns a normalized
  // response; Gate's own approval_state remains authoritative until the
  // result passes the shared decision verifier.
  async getStatus(interaction, policy) {
    const channelConfig = channelConfigFrom(policy);
    if (!isConfigured()) return { state: 'unknown', note: 'a2h provider not configured — stub mode' };
    if (!channelConfig?.gateway_url || !interaction?.providerInteractionId) {
      return { state: 'unknown', note: 'no gateway_url or provider interaction id to poll' };
    }
    if (channelConfig.wire_format === 'gate-legacy') {
      return { state: 'unknown', note: 'legacy wire format has no status endpoint; rely on the signed callback' };
    }
    const endpoints = resolveGatewayEndpoints(channelConfig.gateway_url);
    const body = await callGateway('GET', endpoints.status(interaction.providerInteractionId), undefined, channelConfig);
    return { ...normalizeResponse(body), raw: body };
  },

  // POST /v1/cancel/{interaction_id} (spec §1.7). Best effort — Gate's own
  // POST /v1/intents/:id/cancel-approval is authoritative regardless.
  async cancel(interaction, policy) {
    const channelConfig = channelConfigFrom(policy);
    if (!isConfigured() || !channelConfig?.gateway_url || !interaction?.providerInteractionId || channelConfig.wire_format === 'gate-legacy') {
      return { cancelled: false, note: 'a2h gateway cancellation skipped (stub mode, legacy format, or no provider interaction id)' };
    }
    const endpoints = resolveGatewayEndpoints(channelConfig.gateway_url);
    try {
      const body = await callGateway('POST', endpoints.cancel(interaction.providerInteractionId), {}, channelConfig);
      return { cancelled: true, gateway: body };
    } catch (e) {
      // 409 ERR.CONFLICT: the human already answered — nothing to cancel.
      return { cancelled: false, error: e.message, code: e.code || null };
    }
  },

  // Light protocol-shape sanity check for callers that want to validate a
  // RESPONSE payload before handing it to the shared callback verifier.
  // This is NOT the trust boundary — the callback route is. Accepts both the
  // A2H v1.0 RESPONSE shape and Gate's legacy { protocol: 'a2h.v1' } shape.
  async verifyResponse(response, originalMessageId) {
    const isSpec = response && String(response.type || '').toUpperCase() === 'RESPONSE';
    if (!response || (!isSpec && response.protocol !== 'a2h.v1')) return { valid: false, reason: 'not_a2h_protocol' };
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
