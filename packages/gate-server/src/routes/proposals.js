const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateDeliveryToken, hashPayload, parseExpiry, generateMessageId, generateApprovalLinkToken } = require('../lib/crypto');
const { evaluatePolicy, loadPolicy } = require('../lib/policy');
const { scoreRisk } = require('../lib/risk');
const { logEvent, getAuditTrail } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { RunLedger } = require('../lib/runs');
const { EVENT_TYPES } = require('../lib/runs/constants');
const { APPROVAL_STATES, transitionApprovalState } = require('../lib/approval-lifecycle');
const { getApprovalEvidence, canonicalIntentHash } = require('../lib/evidence');
const { getApprovalProvider, getProviderCapabilities, providerSupportsFactors, listApprovalProviders } = require('../lib/approval-providers');
const { createInteraction, updateInteractionState, setProviderInteractionId, listInteractionsForIntent, INTERACTION_STATES } = require('../lib/approval-ledger');
const { redactChannelAddress, validatePrincipal } = require('../lib/principal');
const { validateProfilePayload, canonicalProfileFieldsHash, summarizeProfile } = require('../lib/action-profiles');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../data/payloads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// POST /v1/propose
router.post('/propose', authenticate, (req, res) => {
  const { payload, destination, policy, expiresIn, metadata, recordCount, on_behalf_of } = req.body;

  if (!destination || !policy) {
    return res.status(400).json({ error: 'destination and policy are required' });
  }

  // Typed action profiles (issue #10) — validated before policy evaluation.
  // A policy can require a specific profile via `require_profile`; a
  // caller-supplied profile is validated regardless, so evidence/audit
  // metadata is only ever attached for a payload that actually matches it.
  const policyForProfile = loadPolicy(policy);
  const requiredProfile = policyForProfile?.require_profile || null;
  const profileId = req.body.profile || null;

  if (requiredProfile && !profileId) {
    return res.status(400).json({ error: 'profile_required', message: `Policy "${policy}" requires a typed profile: ${requiredProfile}` });
  }
  if (requiredProfile && profileId !== requiredProfile) {
    return res.status(400).json({ error: 'profile_mismatch', message: `Policy "${policy}" requires profile "${requiredProfile}", got "${profileId}"` });
  }

  let profileFieldsHash = null;
  if (profileId) {
    const profileCheck = validateProfilePayload(profileId, metadata);
    if (!profileCheck.valid) {
      return res.status(400).json({ error: 'invalid_profile_payload', messages: profileCheck.errors, profile: profileId });
    }
    profileFieldsHash = canonicalProfileFieldsHash(profileId, metadata);
  }

  const proposalId = generateId('int');
  const messageId = generateMessageId();
  const now = Date.now();
  const expirySeconds = parseExpiry(expiresIn || '1h');
  const expiresAt = now + (expirySeconds * 1000);

  // Determine payload type from path or content
  let payloadType = null;
  let payloadPath = null;
  let payloadHash = null;
  let payloadContent = null;

  if (payload) {
    const looksLikeFilePath = /\.(csv|json|txt|pdf|xml|xlsx|jsonl)$/i.test(payload.trim());

    if (looksLikeFilePath) {
      // File path — use extension for type, no content to term-scan
      payloadType = path.extname(payload.trim()).slice(1).toLowerCase();
      payloadPath = payload.trim();
      payloadContent = null;
    } else {
      // Text content (support reply, email body, JSON string, data: URI, etc.)
      payloadContent = payload;
      payloadHash = hashPayload(payload);
      payloadPath = path.join(UPLOAD_DIR, proposalId);
      fs.writeFileSync(payloadPath, payload);
      // Infer type from data: URI prefix if present
      if (payload.startsWith('data:application/json')) payloadType = 'json';
      else if (payload.startsWith('data:text/csv')) payloadType = 'csv';
    }
  }

  // Evaluate policy
  const result = evaluatePolicy(policy, {
    destination,
    payloadType,
    payloadContent,
    recordCount: recordCount ? parseInt(recordCount) : undefined,
    metadata,
    agentId: req.agent?.id
  });

  // Idempotency check — block duplicate intents
  const idempotencyKey = req.body.idempotency_key || null;
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id, status FROM proposals WHERE idempotency_key = ? AND sender_agent_id = ?').get(idempotencyKey, req.agent.id);
    if (existing) {
      return res.status(409).json({
        proposalId: existing.id,
        intentId: existing.id,
        status: 'duplicate_blocked',
        blockReason: `Duplicate intent — idempotency_key already used: ${idempotencyKey}`,
        existingStatus: existing.status
      });
    }
  }

  // Risk scoring
  const risk = scoreRisk({
    destination,
    recordCount: recordCount ? parseInt(recordCount) : 0,
    estimatedValueUsd: req.body.estimated_value_usd ? parseFloat(req.body.estimated_value_usd) : 0,
    sensitivityTags: req.body.sensitivity_tags || [],
    payloadContent,
    policyRequireApproval: null // evaluated in policy engine
  });

  // Approval interaction bookkeeping: intents that need a human get a
  // single-use approval link token, tied to the same expiry as the intent.
  const needsApproval = result.status === 'pending_approval';
  const approvalLinkToken = needsApproval ? generateApprovalLinkToken() : null;

  // Provider-neutral approval dispatch fields (issue #13) — all optional;
  // when omitted, the policy's approval_channel (or the dashboard default)
  // applies unchanged. Validated up front so a bad request never creates a
  // half-dispatched intent.
  const policyForDispatch = needsApproval ? loadPolicy(policy) : null;
  const requestedProvider = req.body.approval_provider || null;
  const requestedChannel = req.body.approval_channel || null;
  const requestedAssurance = req.body.assurance || null;

  // Risk-tiered assurance (issue #15): a policy can declare which approval
  // factors are required per risk level —
  //   assurance: { low: [...], medium: [...], high: [...], critical: [...] }
  // — applied automatically from the intent's computed risk_level whenever
  // the caller doesn't explicitly override required_factors on propose.
  const policyAssuranceFactors = policyForDispatch?.assurance?.[risk.risk_level] || null;
  const resolvedRequiredFactors = requestedAssurance?.required_factors || policyAssuranceFactors || [];
  const resolvedAssuranceLevel = requestedAssurance?.level || (policyAssuranceFactors ? risk.risk_level.toUpperCase() : null);

  if (needsApproval) {
    if (requestedProvider && !listApprovalProviders().includes(requestedProvider)) {
      return res.status(400).json({ error: 'invalid_provider', message: `Unknown approval provider: ${requestedProvider}` });
    }
    const principalCheck = validatePrincipal({ principal_id: req.body.principal_id, channel: requestedChannel });
    if (!principalCheck.valid) {
      return res.status(400).json({ error: 'invalid_principal', messages: principalCheck.errors });
    }
    if (requestedChannel && !requestedChannel.address) {
      return res.status(400).json({ error: 'invalid_channel', message: 'approval_channel.address is required when approval_channel is provided' });
    }
    const effectiveProvider = requestedProvider || policyForDispatch?.approval_channel?.provider || 'dashboard';
    if (resolvedRequiredFactors.length && !providerSupportsFactors(effectiveProvider, resolvedRequiredFactors)) {
      return res.status(400).json({
        error: 'unsupported_factor',
        message: `Provider "${effectiveProvider}" cannot satisfy required factors: ${resolvedRequiredFactors.join(', ')}`,
        provider: effectiveProvider,
        capabilities: getProviderCapabilities(effectiveProvider),
        risk_level: risk.risk_level,
      });
    }
  }

  // Store proposal
  db.prepare(`
    INSERT INTO proposals (id, sender_agent_id, payload_path, payload_hash, payload_type, destination, policy_id, status, block_reason, created_at, expires_at, on_behalf_of, idempotency_key, risk_score, risk_level, sensitivity_tags, estimated_records, estimated_value_usd, action, message_id, approval_state, approval_link_token, approval_link_expires_at, profile_id, profile_fields_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    req.agent.id,
    payloadPath,
    payloadHash,
    payloadType,
    destination,
    policy,
    result.status,
    result.reason || null,
    now,
    expiresAt,
    on_behalf_of || null,
    idempotencyKey,
    risk.risk_score,
    risk.risk_level,
    JSON.stringify(req.body.sensitivity_tags || []),
    recordCount ? parseInt(recordCount) : null,
    req.body.estimated_value_usd ? parseFloat(req.body.estimated_value_usd) : null,
    req.body.action || destination,
    messageId,
    needsApproval ? APPROVAL_STATES.PENDING : (result.status === 'blocked' ? APPROVAL_STATES.FAILED : APPROVAL_STATES.ANSWERED),
    approvalLinkToken,
    needsApproval ? expiresAt : null,
    profileId,
    profileFieldsHash
  );

  let approvalInteractionId = null;
  if (needsApproval) {
    transitionApprovalState(proposalId, APPROVAL_STATES.SENT, { actor: 'system', reason: 'dispatch_attempted' });

    const policyObj = policyForDispatch;
    const providerName = requestedProvider || policyObj?.approval_channel?.provider || 'dashboard';
    const policyChannelConfig = policyObj?.approval_channel?.[providerName] || null;
    const channelAddress = requestedChannel?.address || policyChannelConfig?.to || null;
    const channelType = requestedChannel?.type || (providerName === 'dashboard' ? 'dashboard' : (policyChannelConfig ? providerName : null));

    // Every dispatched approval request — dashboard included — gets a
    // durable ledger row (issue #12), independent of proposals.approval_state.
    const freshProposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    const interaction = createInteraction({
      intentId: proposalId,
      provider: providerName,
      messageId,
      principalId: req.body.principal_id || null,
      channelType,
      channelAddressRedacted: redactChannelAddress(channelAddress),
      approvedIntentHash: canonicalIntentHash(freshProposal),
      requiredFactors: resolvedRequiredFactors,
      assuranceLevel: resolvedAssuranceLevel,
      expiresAt,
    });
    approvalInteractionId = interaction.id;

    if (providerName === 'dashboard') {
      // Local-only channel — the dashboard IS Gate, so there's nothing to
      // dispatch to and no delivery confirmation to wait on.
      transitionApprovalState(proposalId, APPROVAL_STATES.WAITING_INPUT, { actor: 'system', reason: 'awaiting_reviewer' });
      updateInteractionState(interaction.id, INTERACTION_STATES.WAITING_INPUT);
    } else {
      // External channel: dispatch off the request/response cycle (same
      // fire-and-forget pattern as gate_exec/autoDeliver below) so a slow
      // or unreachable provider never blocks the propose response. The
      // approval interaction only reaches WAITING_INPUT once dispatch is
      // confirmed; a failed dispatch moves it to FAILED instead, per the
      // A2H-style lifecycle (issue #3), and never approves/executes anything.
      const approvalUrl = `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`}/v1/approval-links/${approvalLinkToken}`;
      setImmediate(async () => {
        try {
          const provider = getApprovalProvider(providerName);
          const dispatch = await provider.sendAuthorize(
            { id: proposalId, destination, action: req.body.action || destination, message_id: messageId },
            {
              approvalUrl, messageId, policy: policyObj, channel: requestedChannel, assurance: requestedAssurance,
              approvalInteractionId: interaction.id,
              requiredFactors: resolvedRequiredFactors,
              expiresAt: new Date(expiresAt).toISOString(),
              summary: `${req.body.action || destination} via ${policy}`,
              callbackUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`}/v1/approval-callbacks/${providerName}`,
            }
          );
          if (dispatch?.interactionId && dispatch.interactionId !== proposalId) {
            setProviderInteractionId(interaction.id, dispatch.interactionId);
          }
          const transition = transitionApprovalState(proposalId, APPROVAL_STATES.WAITING_INPUT, { actor: 'system', reason: `dispatched_via_${providerName}` });
          if (transition.ok) {
            logEvent(proposalId, 'approval_channel_dispatched', 'system', { provider: providerName });
            updateInteractionState(interaction.id, INTERACTION_STATES.WAITING_INPUT);
          }
        } catch (e) {
          const transition = transitionApprovalState(proposalId, APPROVAL_STATES.FAILED, { actor: 'system', reason: `channel_dispatch_failed: ${e.message}` });
          if (transition.ok) {
            logEvent(proposalId, 'approval_channel_failed', 'system', { provider: providerName, error: e.message });
            updateInteractionState(interaction.id, INTERACTION_STATES.FAILED);
          }
        }
      });
    }
  }

  // Store policy decision
  const decisionId = generateId('dec');
  const reasonCode = result.status === 'blocked'
    ? (result.reason?.includes('threshold') ? 'record_threshold_exceeded'
      : result.reason?.includes('term') ? 'blocked_term_detected'
      : result.reason?.includes('destination') ? 'destination_not_allowed'
      : result.reason?.includes('sensitive') ? 'sensitive_data_detected'
      : 'manual_review_required')
    : result.status === 'approved' ? 'approved_by_policy'
    : 'manual_review_required';

  db.prepare(`
    INSERT INTO policy_decisions (id, intent_id, status, reason_code, reason_detail, risk_score, risk_level, policy_snapshot, required_approvals, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId, proposalId,
    result.status === 'approved' ? 'approved' : result.status === 'blocked' ? 'blocked' : 'pending_approval',
    reasonCode,
    result.reason || null,
    risk.risk_score,
    risk.risk_level,
    JSON.stringify({ policy, destination }),
    result.status === 'pending_approval' ? 1 : 0,
    now
  );

  // Log audit event
  logEvent(proposalId, 'proposed', req.agent.name, { destination, policy, on_behalf_of: on_behalf_of || null });
  logEvent(proposalId, 'policy_checked', 'system', { result: result.status, reason: result.reason });

  // Run Ledger integration (optional — only if runId provided)
  const runId = req.body.runId || null;
  if (runId) {
    const ledger = RunLedger.getRun(runId);
    if (ledger) {
      RunLedger.recordEvent({
        ledgerId: ledger.id,
        eventType: EVENT_TYPES.INTENT_PROPOSED,
        actorId: req.agent.id,
        payload: { intentId: proposalId, destination, policy, recordCount }
      });
      RunLedger.recordEvent({
        ledgerId: ledger.id,
        eventType: EVENT_TYPES.POLICY_CHECKED,
        actorId: 'gate',
        payload: { intentId: proposalId, decision: result.status, reason: result.reason }
      });
    }
  }

  if (result.status === 'blocked') {
    logEvent(proposalId, 'blocked', 'system', { reason: result.reason });
  } else if (result.status === 'approved') {
    logEvent(proposalId, 'approved', 'system', { policy, auto: true });
    
    // Run Ledger: auto-approval = approval_received
    if (runId) {
      const ledger = RunLedger.getRun(runId);
      if (ledger) {
        RunLedger.recordEvent({
          ledgerId: ledger.id,
          eventType: EVENT_TYPES.APPROVAL_RECEIVED,
          actorId: 'gate',
          payload: { intentId: proposalId, auto: true }
        });
      }
    }

    // gate_exec: auto-approved + vault credential → Gate executes immediately
    const { hasCredential } = require('../proxy/vault');
    const { executeIntent }  = require('../proxy/executor');
    if (hasCredential(destination) && process.env.PROXY_API_KEY) {
      const payloadContent = payloadPath && require('fs').existsSync(payloadPath)
        ? require('fs').readFileSync(payloadPath, 'utf8') : payload || null;
      setImmediate(async () => {
        try {
          const r = await executeIntent({ id: proposalId, destination, payloadContent });
          console.log(`[gate_exec] ${proposalId} auto-exec → ${r.succeeded ? 'succeeded' : 'failed'} (HTTP ${r.httpStatus})`);
        } catch (e) {
          console.error(`[gate_exec] Auto-exec error ${proposalId}:`, e.message);
        }
      });
    }
  }

  res.json({
    proposalId,
    intentId: proposalId,   // V2 alias
    messageId,
    status: result.status,
    approvalState: needsApproval
      ? db.prepare('SELECT approval_state FROM proposals WHERE id = ?').get(proposalId).approval_state
      : null,
    approvalLinkToken,
    approvalInteractionId,
    approvalProvider: needsApproval ? (requestedProvider || policyForDispatch?.approval_channel?.provider || 'dashboard') : null,
    requiredApprovalFactors: needsApproval ? resolvedRequiredFactors : [],
    assuranceLevel: needsApproval ? resolvedAssuranceLevel : null,
    profile: profileId,
    profileSummary: profileId ? summarizeProfile(profileId, metadata) : null,
    blockReason: ['blocked','duplicate_blocked'].includes(result.status) ? result.reason : null,
    expiresAt: new Date(expiresAt).toISOString(),
    riskScore: risk.risk_score,
    riskLevel: risk.risk_level,
    riskFactors: risk.factors
  });
});

// GET /v1/proposals/:id
router.get('/proposals/:id', authenticate, (req, res) => {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const isReviewer = (req.agent?.role === 'admin' || req.agent?.role === 'reviewer');
  if (!isReviewer && proposal.sender_agent_id !== req.agent.id) {
    return res.status(403).json({ error: 'forbidden', message: 'Cannot access intents from other agents' });
  }

  const auditTrail = getAuditTrail(req.params.id);
  const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(req.params.id);
  const evidence = getApprovalEvidence(req.params.id);
  const { approval_link_token, ...safeProposal } = proposal;

  res.json({
    ...safeProposal,
    has_approval_link: !!approval_link_token,
    created_at: new Date(proposal.created_at).toISOString(),
    expires_at: proposal.expires_at ? new Date(proposal.expires_at).toISOString() : null,
    approval_link_expires_at: proposal.approval_link_expires_at ? new Date(proposal.approval_link_expires_at).toISOString() : null,
    approval_link_used_at: proposal.approval_link_used_at ? new Date(proposal.approval_link_used_at).toISOString() : null,
    manifest: manifest || null,
    approval_evidence: evidence,
    approval_interactions: listInteractionsForIntent(req.params.id),
    auditTrail
  });
});

module.exports = router;
