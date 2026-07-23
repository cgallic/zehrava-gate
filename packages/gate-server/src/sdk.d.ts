/**
 * zehrava-gate — TypeScript declarations for the JS SDK (src/sdk.js).
 *
 * Hand-written against the actual server route handlers:
 *   - POST /v1/intents            → src/routes/proposals.js (POST /propose)
 *   - POST /v1/intents/:id/approve→ src/routes/approvals.js (POST /approve)
 *   - POST /v1/intents/:id/reject → src/routes/approvals.js (POST /reject)
 *   - POST /v1/intents/:id/execute→ src/routes/executions.js
 *   - GET  /v1/intents/:id        → src/routes/proposals.js (GET /proposals/:id)
 *   - POST /v1/webhooks/register  → src/routes/approvals.js
 *   - /internal/runs/*            → src/routes/runs.js
 */

/** Constructor options for {@link Gate}. Both fields are required. */
export interface GateOptions {
  /** Base URL of the Gate server, e.g. `http://localhost:4000`. A trailing slash is stripped. */
  endpoint: string;
  /** Agent API key (`gate_sk_...`), sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
}

/**
 * Shape of errors rejected by every SDK method: any HTTP response with
 * status >= 400 is turned into an Error with `status` and the parsed JSON
 * body attached. Note: a duplicate `idempotency_key` surfaces here as a
 * 409 whose `body.status` is `"duplicate_blocked"` — not as a resolved value.
 */
export interface GateError extends Error {
  status?: number;
  body?: unknown;
}

/** Risk level computed by the risk-scoring engine (src/lib/risk.js). */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Outcome of policy evaluation for a newly proposed intent (src/lib/policy.js). */
export type PolicyEvaluationStatus = 'approved' | 'blocked' | 'pending_approval';

/**
 * Full lifecycle status of a stored intent/proposal. `duplicate_blocked`
 * is only ever returned in a 409 error body from propose (see GateError),
 * never stored; `delivered` is set by the one-time delivery route.
 */
export type IntentStatus =
  | 'pending_approval'
  | 'approved'
  | 'blocked'
  | 'scheduled'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'delivered'
  | 'duplicate_blocked';

/** A2H-style approval interaction state (src/lib/approval-lifecycle.js). */
export type ApprovalState =
  | 'pending'
  | 'sent'
  | 'waiting_input'
  | 'answered'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type ExecutionMode = 'gate_exec' | 'runner_exec' | 'external_pull';

export type ExecutionStatus = 'scheduled' | 'executing' | 'succeeded' | 'failed' | 'expired';

export type ApprovalDecision = 'APPROVE' | 'REJECT';

/** Options for {@link Gate.propose}. */
export interface ProposeOptions {
  /** Content (text/JSON/data: URI) or a file path ending in .csv/.json/.txt/.pdf/.xml/.xlsx/.jsonl. */
  payload?: string;
  /** Target system, e.g. `'salesforce.import'`. Required by the server. */
  destination: string;
  /** Policy ID (YAML file name without extension), e.g. `'crm-low-risk'`. Required by the server. */
  policy: string;
  /** Batch size for threshold checks. */
  recordCount?: number;
  /** Financial value in USD (contributes to risk score). */
  estimatedValueUsd?: number;
  /** e.g. `['pii', 'financial']`. */
  sensitivityTags?: string[];
  /** Deduplicate retries — a reused key rejects with a 409 `duplicate_blocked` error. */
  idempotencyKey?: string;
  /** Orchestrator agent ID (multi-agent audit). */
  onBehalfOf?: string;
  /** Approval window, e.g. `'1h'`, `'30m'`. Default `'1h'`. */
  expiresIn?: string;
  /** Arbitrary key/value pairs (also carries typed-profile fields and `environment`/`scope` policy inputs). */
  metadata?: Record<string, unknown>;
}

/** Signed A2H-shaped approval evidence bundle (src/lib/evidence.js). */
export interface ApprovalEvidence {
  protocol: string;
  interaction_id: string;
  request_jws: string | null;
  response_jws: string;
  responds_to: string;
  decision: ApprovalDecision;
  /** ISO 8601 timestamp. */
  decided_at: string;
  /** e.g. `'manual.dashboard.v1'`, `'link.single_use.v1'`. */
  factor: string;
  proof: Record<string, unknown>;
  approved_intent_hash: string;
  /** ISO 8601 timestamp, set once the evidence has been consumed by an execution order. */
  consumed_at: string | null;
}

/** Response of `POST /v1/intents` (resolved value of {@link Gate.propose}). */
export interface ProposeResult {
  proposalId: string;
  /** Same value as `proposalId` (V2 alias). */
  intentId: string;
  messageId: string;
  status: PolicyEvaluationStatus;
  /** Non-null only when `status === 'pending_approval'`. */
  approvalState: ApprovalState | null;
  /** Single-use approval-link token; non-null only when approval is required. */
  approvalLinkToken: string | null;
  approvalInteractionId: string | null;
  /** Approval provider the request was dispatched to (e.g. `'dashboard'`); null unless pending approval. */
  approvalProvider: string | null;
  requiredApprovalFactors: string[];
  assuranceLevel: string | null;
  /** Typed action-profile ID, when one was supplied/required. */
  profile: string | null;
  profileSummary: string | null;
  standingApprovalId: string | null;
  /** N-of-M quorum size (1 unless the policy sets `require_approvals`). */
  requiredApprovals: number;
  /** Set when `status === 'blocked'`. */
  blockReason: string | null;
  /** ISO 8601 timestamp. */
  expiresAt: string;
  riskScore: number;
  riskLevel: RiskLevel;
  riskFactors: string[];
}

/** Approve outcome once the decision (or quorum) is final. */
export interface ApproveResultApproved {
  status: 'approved';
  /** Present except on the idempotent already-approved short-circuit path. */
  approvalState?: 'answered';
  /** ISO 8601 timestamp. */
  approvedAt: string;
  intentId: string;
  deliveryToken?: string;
  /** True when the destination auto-delivers on approval (and Gate itself is not executing). */
  autoDeliver?: boolean;
  /** True when Gate executes the write itself (vault credential + proxy enabled). */
  gate_exec?: boolean;
  approvalEvidence?: ApprovalEvidence | null;
}

/** Approve outcome when a vote was recorded but N-of-M quorum is not yet reached. */
export interface ApproveResultQuorumPending {
  status: 'pending_approval';
  approvalState: 'waiting_input';
  intentId: string;
  votes: number;
  requiredApprovals: number;
  votedBy: string[];
}

/** Response of `POST /v1/intents/:id/approve` (resolved value of {@link Gate.approve}). */
export type ApproveResult = ApproveResultApproved | ApproveResultQuorumPending;

/** Response of `POST /v1/intents/:id/reject` (resolved value of {@link Gate.reject}). */
export interface RejectResult {
  status: 'blocked';
  approvalState: 'answered';
  reason?: string | null;
  approvalEvidence: ApprovalEvidence | null;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff_seconds: number;
}

/**
 * Signed execution order — response of `POST /v1/intents/:id/execute` and
 * `GET /v1/executions/:id` (see schemas/execution-order.json).
 */
export interface ExecutionOrder {
  executionId: string;
  /** Same value as `executionId` (snake_case alias). */
  execution_id: string;
  intent_id: string;
  mode: ExecutionMode;
  destination: string;
  action: string;
  payload_ref: string | null;
  payload_hash: string | null;
  /** One-time `gex_` token, 15 min TTL. The worker uses this to perform the write. */
  execution_token: string;
  retry_policy: RetryPolicy;
  status: ExecutionStatus;
  /** ISO 8601 timestamp. */
  issued_at: string;
  /** ISO 8601 timestamp. */
  expires_at: string;
  /** ISO 8601 timestamp, null until reported. */
  executed_at: string | null;
  result: Record<string, unknown> | null;
  approval_evidence: ApprovalEvidence | null;
}

/** One audit-trail entry as returned inside intent details / audit routes. */
export interface AuditEvent {
  id: string;
  proposal_id: string | null;
  event_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  created_at: string;
}

/** Durable per-dispatch approval interaction record (src/lib/approval-ledger.js). */
export interface ApprovalInteraction {
  id: string;
  intentId: string;
  provider: string;
  providerInteractionId: string | null;
  messageId: string;
  state: ApprovalState;
  principalId: string | null;
  channelType: string | null;
  channelAddressRedacted: string | null;
  approvedIntentHash: string | null;
  requiredFactors: string[];
  assuranceLevel: string | null;
  evidence: Record<string, unknown> | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  expiresAt: string | null;
  [key: string]: unknown;
}

/** Signed delivery manifest row attached to an approved intent. */
export interface Manifest {
  id: string;
  proposal_id: string;
  signed_by: string;
  delivery_token: string;
  delivered_at?: number | null;
  [key: string]: unknown;
}

/**
 * Full intent details — response of `GET /v1/intents/:id` (resolved value of
 * {@link Gate.verify}). This is the stored proposal row (snake_case columns)
 * plus computed fields; the single-use `approval_link_token` is redacted and
 * replaced with `has_approval_link`.
 */
export interface IntentDetail {
  id: string;
  sender_agent_id: string;
  payload_path: string | null;
  payload_hash: string | null;
  payload_type: string | null;
  destination: string;
  policy_id: string;
  status: IntentStatus;
  block_reason: string | null;
  /** ISO 8601 timestamp. */
  created_at: string;
  /** ISO 8601 timestamp. */
  expires_at: string | null;
  on_behalf_of: string | null;
  idempotency_key: string | null;
  risk_score: number | null;
  risk_level: RiskLevel | null;
  /** JSON-encoded string array as stored, e.g. `'["pii"]'`. */
  sensitivity_tags: string | null;
  estimated_records: number | null;
  estimated_value_usd: number | null;
  action: string | null;
  message_id: string | null;
  approval_state: ApprovalState | null;
  /** ISO 8601 timestamp. */
  approval_link_expires_at: string | null;
  /** ISO 8601 timestamp. */
  approval_link_used_at: string | null;
  profile_id: string | null;
  profile_fields_hash: string | null;
  required_approvals: number | null;
  standing_approval_id: string | null;
  has_approval_link: boolean;
  manifest: Manifest | null;
  approval_evidence: ApprovalEvidence | null;
  approval_interactions: ApprovalInteraction[];
  auditTrail: AuditEvent[];
  [key: string]: unknown;
}

export interface RegisterWebhookOptions {
  intentId: string;
  /** URL that receives a signed POST when the intent is approved/rejected/cancelled. */
  url: string;
  /** Shared secret — sent back as `X-Gate-Secret` and used for the `X-Gate-Signature` HMAC. */
  secret?: string;
}

/** Response of `POST /v1/webhooks/register`. */
export interface RegisterWebhookResult {
  registered: boolean;
  webhookId: string;
  intentId: string;
  url: string;
}

// ─── Run Ledger (internal API: /internal/runs/*) ───────────────────────────

export type RunStatus = string;

export interface StartRunOptions {
  /** Agent ID running this operation. Required by the server. */
  agentId: string;
  /** Human-readable summary of intent. Required by the server. */
  intentSummary: string;
  /** Runtime identifier (default: 'zehrava-gate'). */
  runtime?: string;
  /** Parent run for nested execution. */
  parentRunId?: string;
  /** Allowed capabilities. */
  permissions?: Record<string, unknown>;
}

/** Response of `POST /internal/runs/start`. */
export interface StartRunResult {
  runId: string;
  ledgerId: string;
  status: RunStatus;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

export interface RecordEventOptions {
  runId: string;
  /** Event type, e.g. 'tool_call_finished'. Required by the server. */
  eventType: string;
  actorId?: string;
  stepName?: string;
  payload?: Record<string, unknown>;
  sideEffectClass?: string;
  sideEffectKey?: string;
}

/** Response of `POST /internal/runs/:runId/events`. */
export interface RecordEventResult {
  eventId: string;
  seq: number;
  eventType: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
}

export interface CreateCheckpointOptions {
  runId: string;
  /** Event to checkpoint at (default: latest). */
  eventId?: string;
  reason?: string;
  suggestedNextAction?: string;
}

/** Response of `POST /internal/runs/:runId/checkpoint`. */
export interface CreateCheckpointResult {
  checkpointId: string;
  sealedHash: string;
  isResumable: boolean;
  reason?: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

export interface ResumeRunOptions {
  runId: string;
  /** Specific checkpoint to resume from (default: latest resumable). */
  fromCheckpointId?: string;
}

/** Response of `POST /internal/runs/:runId/resume`. */
export interface ResumeRunResult {
  runId: string;
  ledgerId: string;
  checkpointId: string;
  runtime: string;
  agentId: string;
  intentSummary: string;
  currentStep: string | null;
  receipts: unknown[];
  artifacts: unknown[];
  unresolvedApprovals: unknown[];
  remainingPermissions: Record<string, unknown> | null;
  blockedCapabilities: unknown[] | null;
  nonReplayableSideEffects: unknown[];
  [key: string]: unknown;
}

export interface RunEventSummary {
  eventId: string;
  seq: number;
  type: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  actor: string | null;
  step: string | null;
  sideEffectClass: string | null;
  status: string;
}

export interface RunEventDetail extends RunEventSummary {
  payload: Record<string, unknown>;
  sideEffectKey: string | null;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

/** Response of `GET /internal/runs/:runId`. */
export interface GetRunResult {
  run: {
    runId: string;
    ledgerId: string;
    agentId: string;
    intentSummary: string;
    status: RunStatus;
    currentStep: string | null;
    lastSafeEventId: string | null;
    /** Unix epoch milliseconds. */
    createdAt: number;
    /** Unix epoch milliseconds. */
    updatedAt: number;
  };
  events: RunEventSummary[];
  checkpoints: Array<{
    checkpointId: string;
    eventId: string;
    reason: string | null;
    isResumable: boolean;
    /** Unix epoch milliseconds. */
    createdAt: number;
  }>;
  artifacts: Array<{
    artifactId: string;
    type: string;
    uri: string;
    hash: string | null;
    /** Unix epoch milliseconds. */
    createdAt: number;
  }>;
  resumableCheckpoints: unknown[];
}

/** Response of `GET /internal/runs/:runId/events`. */
export interface GetRunEventsResult {
  runId: string;
  events: RunEventDetail[];
}

/** Response of `POST /internal/runs/:runId/verify`. */
export interface VerifyRunResult {
  runId: string;
  ledgerIntegrity: { valid: boolean; hash: string | null };
  checkpointIntegrity: {
    valid: boolean;
    checkpoints: Array<{ checkpointId: string; valid: boolean; reason?: string; [key: string]: unknown }>;
  };
  lineageContinuity: { valid: boolean; parentRunId: string | null };
}

/**
 * Zehrava Gate client — write-path control plane for AI agents.
 *
 * ```ts
 * import { Gate } from 'zehrava-gate';
 * const gate = new Gate({ endpoint: 'http://localhost:4000', apiKey: 'gate_sk_...' });
 * const p = await gate.propose({ payload: '...', destination: 'salesforce.import', policy: 'crm-low-risk' });
 * // p.status → "approved" | "blocked" | "pending_approval"
 * ```
 *
 * All methods reject with a {@link GateError} on any HTTP status >= 400.
 */
export class Gate {
  constructor(options: GateOptions);

  /** Base URL with any trailing slash removed. */
  endpoint: string;
  apiKey: string;

  /** Submit an intent for policy evaluation. `POST /v1/intents`. */
  propose(opts: ProposeOptions): Promise<ProposeResult>;

  /** Approve a pending intent (reviewer/admin API key required). `POST /v1/intents/:id/approve`. */
  approve(opts: { intentId: string }): Promise<ApproveResult>;

  /** Reject a pending intent (reviewer/admin API key required). `POST /v1/intents/:id/reject`. */
  reject(opts: { intentId: string; reason?: string }): Promise<RejectResult>;

  /**
   * Request a signed execution order for an approved intent.
   * Returns a one-time `gex_` token (15 min TTL). `POST /v1/intents/:id/execute`.
   */
  execute(opts: { intentId: string }): Promise<ExecutionOrder>;

  /** Fetch full intent details including approval evidence, manifest, and audit trail. `GET /v1/intents/:id`. */
  verify(opts: { intentId: string }): Promise<IntentDetail>;

  /** Register a webhook for intent state transitions (approved | rejected). `POST /v1/webhooks/register`. */
  registerWebhook(opts: RegisterWebhookOptions): Promise<RegisterWebhookResult>;

  // ─── Run Ledger (internal, unauthenticated /internal/runs/* API) ────────

  /** Start a new run with execution continuity tracking. `POST /internal/runs/start`. */
  startRun(opts: StartRunOptions): Promise<StartRunResult>;

  /** Record an event in a run. `POST /internal/runs/:runId/events`. */
  recordEvent(opts: RecordEventOptions): Promise<RecordEventResult>;

  /** Create a sealed checkpoint for resumption. `POST /internal/runs/:runId/checkpoint`. */
  createCheckpoint(opts: CreateCheckpointOptions): Promise<CreateCheckpointResult>;

  /** Resume a run from its latest (or a specific) checkpoint. `POST /internal/runs/:runId/resume`. */
  resumeRun(opts: ResumeRunOptions): Promise<ResumeRunResult>;

  /** Get full run details. `GET /internal/runs/:runId`. */
  getRun(opts: { runId: string }): Promise<GetRunResult>;

  /** Get all events for a run. `GET /internal/runs/:runId/events`. */
  getRunEvents(opts: { runId: string }): Promise<GetRunEventsResult>;

  /** Verify run/checkpoint/lineage integrity. `POST /internal/runs/:runId/verify`. */
  verifyRun(opts: { runId: string }): Promise<VerifyRunResult>;
}
