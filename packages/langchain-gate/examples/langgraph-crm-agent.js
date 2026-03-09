/**
 * LangGraph CRM agent — Gate governance example
 *
 * This example shows a StateGraph where:
 *   1. Agent decides what action to take
 *   2. Gate evaluates the intent (field checks, rate limits, policy)
 *   3. Approved intents execute; blocked intents stop the graph
 *   4. Pending intents wait for human approval
 *
 * Run: node examples/langgraph-crm-agent.js
 *
 * Dependencies (peerDeps, not bundled):
 *   npm install zehrava-gate @langchain/core @langchain/langgraph
 */

// In production: require('zehrava-gate')
// For this example we resolve from the monorepo SDK package
let Gate;
try {
  ({ Gate } = require('zehrava-gate'));
} catch {
  // Monorepo path fallback (gate-server ships the SDK at src/sdk.js)
  const sdkPath = require('path').join(__dirname, '../../gate-server/src/sdk.js');
  ({ Gate } = require(sdkPath));
}
const { GateTool, GateToolkit, gateRouteAfter, gateNode, GateBlockedError } = require('../src/index.js');

// ── Stub LangChain tools (replace with real tools in production) ─────────────

const crmUpdateTool = {
  name: 'crm-update',
  description: 'Write a contact update to Salesforce CRM',
  schema: { type: 'object', properties: { contact_id: { type: 'string' }, data: { type: 'object' } } },
  _call: async (input) => {
    console.log('[crm-update] Writing to Salesforce:', input);
    return JSON.stringify({ success: true, updated: JSON.parse(input).contact_id });
  },
};

const emailTool = {
  name: 'send-email',
  description: 'Send an email via SendGrid',
  schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } },
  _call: async (input) => {
    console.log('[send-email] Sending email:', input);
    return JSON.stringify({ delivered: true });
  },
};

// ── Gate client setup ─────────────────────────────────────────────────────────

const gate = new Gate({
  endpoint: process.env.GATE_URL || 'http://localhost:3001',
  apiKey: process.env.GATE_API_KEY || 'gate_sk_demo',
});

// ── Wrap tools with Gate ──────────────────────────────────────────────────────

const toolkit = new GateToolkit({
  tools: [crmUpdateTool, emailTool],
  gate,
  policies: {
    'send-email':  'outbound-email',
    'crm-update':  'crm-low-risk',
    '__default__': 'crm-low-risk',
  },
  destinations: {
    'send-email':  'sendgrid.send',
    'crm-update':  'salesforce.api',
    '__default__': 'generic.http',
  },
  toolOptions: {
    pollIntervalMs: 3000,
    timeoutMs: 120_000,
    onPending: (intentId, status, count) => {
      console.log(`[gate] Still waiting for approval: ${intentId} (poll #${count})`);
    },
    onBlocked: (intentId, reason) => {
      console.error(`[gate] BLOCKED: ${intentId} — ${reason}`);
      return JSON.stringify({ blocked: true, reason });
    },
  },
});

const [governedEmail, governedCrm] = toolkit.getTools();

// ── GateTool standalone usage ─────────────────────────────────────────────────

async function runStandaloneExample() {
  console.log('\n=== Standalone GateTool example ===');
  const tool = new GateTool({
    tool: emailTool,
    gate,
    policy: 'outbound-email',
    destination: 'sendgrid.send',
    toolOptions: {
      idempotencyKeyFn: (input) => `email-${JSON.parse(input).to}-${Date.now()}`,
      timeoutMs: 60_000,
    },
  });

  const input = JSON.stringify({
    to: 'lead@example.com',
    subject: 'Follow-up on your inquiry',
    body: 'Thank you for your interest...',
  });

  try {
    const result = await tool._call(input);
    console.log('[GateTool] result:', result);
  } catch (err) {
    if (err instanceof GateBlockedError) {
      console.error('[GateTool] Gate blocked this action:', err.blockReason);
    } else {
      console.error('[GateTool] Error:', err.message);
    }
  }
}

// ── LangGraph-style StateGraph example (inline, without importing langgraph) ─
// Demonstrates the hook pattern — replace with real StateGraph in production.

async function runStateMachineExample() {
  console.log('\n=== LangGraph StateGraph pattern ===');

  /**
   * In a real LangGraph app this would be:
   *
   *   const { StateGraph, END } = require('@langchain/langgraph');
   *   const { gateRouteAfter, gateNode } = require('@zehrava/langchain-gate');
   *
   *   const graph = new StateGraph({ ... });
   *   graph.addNode('submit_to_gate', gateNode({ gate, buildIntent: (state) => ({
   *     payload: JSON.stringify(state.crmPayload),
   *     destination: 'salesforce.api',
   *     policy: 'crm-low-risk',
   *   })));
   *
   *   graph.addConditionalEdges('submit_to_gate', gateRouteAfter('gateStatus'), {
   *     execute:  'run_crm_tool',
   *     blocked:  'handle_blocked',
   *     pending:  'notify_human',
   *     __end__:  END,
   *   });
   */

  // Simulate the node function:
  const submitNode = gateNode({
    gate,
    buildIntent: (state) => ({
      payload: JSON.stringify(state.crmPayload),
      destination: 'salesforce.api',
      policy: 'crm-low-risk',
      recordCount: 1,
    }),
  });

  const state = {
    crmPayload: { contact_id: 'ct_abc123', data: { status: 'qualified' } },
  };

  let nextState;
  try {
    nextState = await submitNode(state);
    console.log('[graph] Gate node returned:', nextState);
  } catch (e) {
    console.error('[graph] Gate node failed:', e.message);
    return;
  }

  const route = gateRouteAfter('gateStatus')({ ...state, ...nextState });
  console.log('[graph] Next edge:', route);

  if (route === 'execute') {
    const result = await crmUpdateTool._call(JSON.stringify(state.crmPayload));
    console.log('[graph] Tool result:', result);
  } else if (route === 'blocked') {
    console.log('[graph] Halting — Gate blocked this action.');
  } else if (route === 'pending') {
    console.log('[graph] Pausing — waiting for human approval via Gate dashboard.');
    console.log(`[graph] IntentId: ${nextState.gateIntentId}`);
    console.log('[graph] Approve at: http://localhost:3001/dashboard');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes('--dry-run');

if (isDryRun) {
  // For CI / testing — just validate imports work
  console.log('Imports OK:', { GateTool: !!GateTool, GateToolkit: !!GateToolkit, gateRouteAfter: !!gateRouteAfter, gateNode: !!gateNode });
  process.exit(0);
} else {
  runStandaloneExample()
    .then(runStateMachineExample)
    .catch(console.error);
}
