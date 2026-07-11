// Gate MCP tool handlers (issue #9). Every tool is a thin, strict-schema
// wrapper over the existing Gate HTTP API — none of them execute a write
// directly or bypass policy/approval/execution-token issuance. An MCP
// agent that only has these tools can request that a write happen and
// find out whether it was allowed; it can never make the write happen
// without Gate's own propose -> policy -> approval -> execution-token
// pipeline agreeing to it.
//
// Exported as plain async functions (not bound to the MCP SDK) so they can
// be unit-tested directly against a real gate-server instance without
// needing a live MCP stdio transport in the loop.

import { z } from 'zod';
import { gateRequest } from './gate-client.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared "what am I proposing" shape — every write-intent tool binds to an
// exact destination + policy + payload/profile, never an ambiguous action.
const proposeShape = {
  destination: z.string().min(1).describe('Destination system.action, e.g. "stripe.refund" or "gmail.send"'),
  policy: z.string().min(1).describe('Gate policy ID to evaluate this action against'),
  payload: z.string().optional().describe('Raw payload content (text/JSON/CSV) or a file path'),
  metadata: z.record(z.any()).optional().describe('Structured fields — required if `profile` is set'),
  profile: z.string().optional().describe('Typed action profile id, e.g. "payment.refund.v1" (see lib/action-profiles.js)'),
  idempotency_key: z.string().optional().describe('Prevents duplicate submission of the same logical action'),
  estimated_value_usd: z.number().optional(),
  principal_id: z.string().optional().describe('Stable human identity this action is being proposed on behalf of'),
  approval_provider: z.string().optional(),
};

async function proposeIntent(args, config) {
  const { status, body } = await gateRequest('POST', '/v1/propose', { body: args, config });
  return { httpStatus: status, ...body };
}

async function getStatus(args, config) {
  const { status, body } = await gateRequest('GET', `/v1/intents/${args.intent_id}`, { config });
  return { httpStatus: status, ...body };
}

async function getAudit(args, config) {
  const { status, body } = await gateRequest('GET', `/v1/audit/${args.intent_id}`, { config });
  return { httpStatus: status, ...body };
}

// Propose AND block until a human reaches a terminal decision (or the
// timeout elapses), then — only on approval — request an execution token.
// This is the "human_authorize" primitive: it never substitutes for Gate's
// own decision, it just waits for one and reports it.
async function authorizeAction(args, config) {
  const { timeout_ms = 300_000, poll_interval_ms = 3_000, ...proposeArgs } = args;
  const proposed = await proposeIntent(proposeArgs, config);
  if (proposed.status !== 'pending_approval') {
    return await maybeAttachExecution(proposed, config);
  }

  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    await sleep(poll_interval_ms);
    const intent = await getStatus({ intent_id: proposed.intentId }, config);
    if (intent.status !== 'pending_approval') {
      return await maybeAttachExecution({ ...proposed, ...intent }, config);
    }
  }
  return { ...proposed, timedOut: true, message: 'Authorization timed out waiting for a human decision' };
}

async function maybeAttachExecution(intentResult, config) {
  if (intentResult.status !== 'approved') return intentResult;
  const intentId = intentResult.intentId || intentResult.id;
  const { status, body } = await gateRequest('POST', `/v1/intents/${intentId}/execute`, { config });
  if (status !== 201) return { ...intentResult, executionRequestFailed: true, executionError: body };
  return { ...intentResult, execution: body };
}

// Gate has no separate free-text "ask a human anything" channel — this
// reuses the same propose/approve pipeline as gate_authorize_action, but
// reframes the response around the human's decision + any reason they gave
// as the "collected input," which is the closest honest mapping onto
// Gate's actual decision primitives (see README for the tradeoff).
async function collectInput(args, config) {
  const result = await authorizeAction(args, config);
  return {
    decision: result.status === 'approved' ? 'APPROVE' : result.status === 'blocked' ? 'DECLINE' : result.status,
    responseText: result.blockReason || result.block_reason || null,
    raw: result,
  };
}

// Reports the outcome of an execution this agent already holds a token
// for (obtained via gate_authorize_action's `execution.execution_token`).
// This tool cannot itself produce an execution token — it can only report
// against one that Gate already issued.
async function sendResult(args, config) {
  const { execution_id, execution_token, status, result } = args;
  const { status: httpStatus, body } = await gateRequest(
    'POST',
    `/v1/executions/${execution_id}/report`,
    { body: { status, result }, config, bearerOverride: execution_token }
  );
  return { httpStatus, ...body };
}

const TOOLS = [
  {
    name: 'gate_propose_intent',
    description: 'Propose a governed write action to Zehrava Gate for policy evaluation. Returns immediately with the decision (approved / blocked / pending_approval) — does not wait for a human. Use gate_authorize_action instead if you want to block until a human decides.',
    schema: proposeShape,
    handler: proposeIntent,
  },
  {
    name: 'gate_authorize_action',
    description: 'Propose an action and block until a human reaches a decision (approved/blocked/expired) or the timeout elapses. On approval, also requests an execution token so the caller can perform the actual side effect and then report it via gate_send_result. Never bypasses Gate policy — this only waits for and reports Gate\'s own decision.',
    schema: { ...proposeShape, timeout_ms: z.number().optional().describe('Max time to wait for a human decision, default 300000ms'), poll_interval_ms: z.number().optional().describe('Polling interval while pending, default 3000ms') },
    handler: authorizeAction,
  },
  {
    name: 'gate_collect_input',
    description: 'Ask a human to review a proposed action and collect their decision (and any reason they gave) as structured input, via Gate\'s propose/approve pipeline. Gate does not have a separate free-text channel — a REJECT decision\'s `reason` field is the closest analog to "collected input."',
    schema: { ...proposeShape, timeout_ms: z.number().optional(), poll_interval_ms: z.number().optional() },
    handler: collectInput,
  },
  {
    name: 'gate_send_result',
    description: 'Report the outcome of executing a Gate-approved action. Requires an execution_id and execution_token obtained from gate_authorize_action\'s `execution` field — this tool cannot execute anything itself, only report a result for an execution Gate already authorized.',
    schema: {
      execution_id: z.string().min(1),
      execution_token: z.string().optional().describe('Bearer token from the execution object; falls back to the server\'s configured API key if omitted'),
      status: z.enum(['succeeded', 'failed']),
      result: z.record(z.any()).optional(),
    },
    handler: sendResult,
  },
  {
    name: 'gate_get_status',
    description: 'Get the current status, approval state, and evidence for a Gate intent by ID.',
    schema: { intent_id: z.string().min(1) },
    handler: getStatus,
  },
  {
    name: 'gate_get_audit',
    description: 'Get the full audit trail and approval evidence bundle for a Gate intent by ID.',
    schema: { intent_id: z.string().min(1) },
    handler: getAudit,
  },
];

export { TOOLS, proposeIntent, authorizeAction, collectInput, sendResult, getStatus, getAudit };
