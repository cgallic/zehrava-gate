// Status poller for A2H approvals (spec §1.7, §1.12.9: "Gateways MUST
// support polling regardless of webhook availability"). Webhooks are the
// fast path; polling is the fallback for gateways that never call back
// (the twilio-labs reference gateway is poll-only) and for webhook
// deliveries that were lost.
//
// A polled result is trusted exactly as far as the transport: Gate called
// the configured gateway over its own authenticated request. It earns the
// human factor the gateway attests to, plus `a2h.signed_response.v1` /
// `a2h.jws.v1` only when the status body carries a valid gateway JWS — so a
// policy that requires a signed response fails closed on unsigned polls.
//
// Timers are in-process; resumePending() re-arms them on server start.

const db = require('./db');
const { loadPolicy } = require('./policy');
const { getInteraction, INTERACTION_STATES } = require('./approval-ledger');
const { A2H_OPEN_STATES } = require('./a2h-protocol');

const OPEN_INTERACTION_STATES = new Set([INTERACTION_STATES.PENDING, INTERACTION_STATES.SENT, INTERACTION_STATES.WAITING_INPUT]);
const MAX_BACKOFF_MS = 60_000;
const timers = new Map();

function intervalMsFor(policy) {
  const sec = Number(policy?.approval_channel?.a2h?.poll_interval_sec);
  if (Number.isFinite(sec) && sec > 0) return Math.max(250, sec * 1000);
  const envMs = Number(process.env.A2H_POLL_INTERVAL_MS);
  return Number.isFinite(envMs) && envMs > 0 ? envMs : 3000;
}

function stop(interactionId) {
  const t = timers.get(interactionId);
  if (t) clearTimeout(t);
  timers.delete(interactionId);
}

function schedule(interactionId, delayMs, failures) {
  stop(interactionId);
  const t = setTimeout(() => {
    timers.delete(interactionId);
    pollOnce(interactionId, failures).catch((e) => console.error('[a2h-poller] unexpected error:', e));
  }, delayMs);
  t.unref();
  timers.set(interactionId, t);
}

async function pollOnce(interactionId, failures = 0) {
  const interaction = getInteraction(interactionId);
  if (!interaction || interaction.provider !== 'a2h' || !OPEN_INTERACTION_STATES.has(interaction.state)) return stop(interactionId);
  if (!interaction.providerInteractionId) return stop(interactionId);

  const proposal = db.prepare('SELECT policy_id FROM proposals WHERE id = ?').get(interaction.intentId);
  const policy = proposal ? loadPolicy(proposal.policy_id) : null;
  if (!policy || policy.approval_channel?.a2h?.poll === false) return stop(interactionId);

  // Lazy: routes/approvals pulls in the whole approval stack.
  const { applyA2HResponse, closeProviderInteraction } = require('../routes/approvals');

  if (interaction.expiresAt && Date.now() > new Date(interaction.expiresAt).getTime()) {
    closeProviderInteraction({ providerName: 'a2h', interaction, outcome: 'expired', reason: 'a2h_poll: ttl elapsed' });
    return stop(interactionId);
  }

  const interval = intervalMsFor(policy);
  let status;
  try {
    const provider = require('./approval-providers/a2h');
    status = await provider.getStatus(interaction, policy);
  } catch (e) {
    const nextFailures = failures + 1;
    if (nextFailures === 1 || nextFailures % 10 === 0) {
      console.warn(`[a2h-poller] status poll failed for ${interactionId} (${nextFailures}x): ${e.message}`);
    }
    return schedule(interactionId, Math.min(interval * 2 ** Math.min(nextFailures, 5), MAX_BACKOFF_MS), nextFailures);
  }

  if (!status || status.state === 'unknown' || A2H_OPEN_STATES.has(status.state)) {
    return schedule(interactionId, interval, 0);
  }

  const result = await applyA2HResponse({ interaction, body: status.raw || status, transport: 'poll' });
  if (result.httpStatus >= 400 && result.body?.error !== 'interaction_not_pending') {
    // The gateway's answer is final, so nothing better will ever arrive —
    // fail the approval visibly instead of leaving it open until expiry.
    const detail = `${result.body?.error}${result.body?.reason ? ` (${result.body.reason})` : ''}${result.body?.missing ? ` missing ${result.body.missing.join(', ')}` : ''}`;
    console.warn(`[a2h-poller] gateway answer for ${interactionId} not applied: ${detail}`);
    const current = getInteraction(interactionId);
    if (current) closeProviderInteraction({ providerName: 'a2h', interaction: current, outcome: 'failed', reason: `a2h_poll_rejected: ${detail}` });
  }
  return stop(interactionId);
}

// Called right after a successful dispatch.
function start(interactionId) {
  const interaction = getInteraction(interactionId);
  if (!interaction) return;
  const proposal = db.prepare('SELECT policy_id FROM proposals WHERE id = ?').get(interaction.intentId);
  schedule(interactionId, intervalMsFor(proposal ? loadPolicy(proposal.policy_id) : null), 0);
}

// Re-arm polling for open A2H interactions after a restart.
function resumePending() {
  const rows = db.prepare(`
    SELECT id FROM approval_interactions
    WHERE provider = 'a2h' AND provider_interaction_id IS NOT NULL
      AND state IN (?, ?, ?)
  `).all(INTERACTION_STATES.PENDING, INTERACTION_STATES.SENT, INTERACTION_STATES.WAITING_INPUT);
  rows.forEach((row, i) => schedule(row.id, 500 + i * 50, 0));
  return rows.length;
}

module.exports = { start, stop, pollOnce, resumePending };
