/**
 * KaiCalls approval provider — a NOTIFICATION channel, not a decision
 * authority. Gate remains the sole place a decision is captured: this
 * provider only texts (and optionally calls) the human named in policy
 * with a link to Gate's own single-use approval page
 * (POST /v1/approval-links/:token/approve|reject). There is no signed
 * external RESPONSE to trust, so verifyResponse() is a deliberate no-op —
 * unlike a true external-approval-authority bridge (see issue #7), this
 * integration never lets KaiCalls itself approve or reject anything.
 *
 * Configure via policy YAML:
 *   approval_channel:
 *     provider: kaicalls
 *     kaicalls:
 *       to: "+15550001234"        # E.164, required
 *       from_agent_id: "agt_..."  # KaiCalls agent/phone line, required
 *       voice_call: true          # optional, default true — also places a call
 *       lead_id: "..."            # optional, attributes the SMS to a KaiCalls lead
 *
 * Wire real credentials via KAICALLS_API_BASE_URL + KAICALLS_API_KEY. Until
 * both are set, every call is logged and returned as a stub — nothing is
 * sent to a real phone. The endpoint paths below are placeholders; confirm
 * them against real KaiCalls REST API docs before pointing this at
 * production traffic.
 */

function isConfigured() {
  return !!(process.env.KAICALLS_API_BASE_URL && process.env.KAICALLS_API_KEY);
}

async function callKaiCallsRestApi(path, body) {
  const baseUrl = process.env.KAICALLS_API_BASE_URL.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.KAICALLS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `KaiCalls API HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function stubResult(kind, body) {
  console.log(`[kaicalls-provider] STUB (KAICALLS_API_BASE_URL/KAICALLS_API_KEY not set) — would ${kind}:`, JSON.stringify(body));
  return { stub: true, kind, ...body };
}

function callScript(approvalUrl, destination) {
  return `You have a pending approval request from Zehrava Gate for ${destination}. ` +
    `Check the text message just sent to this number for the secure approval link.`;
}

const provider = {
  name: 'kaicalls',

  async sendAuthorize(intent, approvalRequest) {
    const channelConfig = approvalRequest.policy?.approval_channel?.kaicalls;
    if (!channelConfig?.to) {
      throw new Error('policy.approval_channel.kaicalls.to (E.164 phone number) is required');
    }
    if (!channelConfig?.from_agent_id) {
      throw new Error('policy.approval_channel.kaicalls.from_agent_id is required');
    }

    const message = `Zehrava Gate approval needed: ${intent.action || intent.destination}. ` +
      `Open ${approvalRequest.approvalUrl} to approve or reject. This link is single-use and expires soon.`;

    const smsBody = {
      from_agent_id: channelConfig.from_agent_id,
      to: channelConfig.to,
      message,
      ...(channelConfig.lead_id ? { lead_id: channelConfig.lead_id } : {}),
    };
    const smsResult = isConfigured()
      ? await callKaiCallsRestApi('/v1/sms/send', smsBody)
      : stubResult('send_sms', smsBody);

    let callResult = null;
    if (channelConfig.voice_call !== false) {
      const callBody = {
        agent_id: channelConfig.from_agent_id,
        to: channelConfig.to,
        script: callScript(approvalRequest.approvalUrl, intent.destination),
      };
      callResult = isConfigured()
        ? await callKaiCallsRestApi('/v1/calls/place', callBody)
        : stubResult('place_call', callBody);
    }

    return {
      interactionId: intent.id,
      messageId: approvalRequest.messageId,
      state: 'sent',
      channel: { sms: smsResult, call: callResult },
    };
  },

  // Best-effort delivery/call status from KaiCalls' side. Gate's own
  // approval_state is always the authoritative record of whether the
  // intent was actually decided — this is informational only.
  async getStatus(interactionId) {
    if (!isConfigured()) return { state: 'unknown', note: 'kaicalls provider not configured — stub mode' };
    try {
      return await callKaiCallsRestApi(`/v1/calls/${interactionId}/status`, {});
    } catch (e) {
      return { state: 'unknown', error: e.message };
    }
  },

  // KaiCalls has no way to unsend an already-delivered SMS. This never
  // blocks Gate's own cancel-approval flow, which is authoritative and
  // local regardless of what any provider reports here.
  async cancel() {
    return { cancelled: false, note: 'KaiCalls SMS cannot be recalled once sent — this is a no-op' };
  },

  // Deliberately always valid: the decision is captured by Gate's own
  // approval-link endpoints, never by an external signed response from
  // KaiCalls, so there is nothing to verify.
  async verifyResponse() {
    return { valid: true, note: 'decision capture happens in Gate directly; KaiCalls only delivers the notification' };
  },
};

module.exports = provider;
