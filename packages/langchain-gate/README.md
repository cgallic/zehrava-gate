# @zehrava/langchain-gate

Wrap LangChain tools and LangGraph graphs with [Zehrava Gate](https://zehrava.com) — deterministic policy enforcement before any tool executes.

Every tool call becomes a governed intent. Gate evaluates it against your YAML policy (field checks, rate limits, environment thresholds) before the tool runs. No LLM in the policy path.

## What Gate does here

- **Approved** → the underlying tool executes normally
- **Blocked** → `GateBlockedError` is thrown (or your `onBlocked` handler runs)
- **Pending approval** → polls until a human approves, rejects, or your `timeoutMs` expires

Gate does not rewrite the LangChain API, add latency on auto-approved calls (< 5ms), or require changes to your tool logic.

## Install

```bash
npm install @zehrava/langchain-gate zehrava-gate
npm install @langchain/core          # peer dep
npm install @langchain/langgraph     # only if using graph hooks
```

Run Gate locally:

```bash
npx zehrava-gate start --api-key gate_sk_...
```

## Wrap a single tool

```js
const { Gate } = require('zehrava-gate');
const { GateTool, GateBlockedError } = require('@zehrava/langchain-gate');

const gate = new Gate({ apiUrl: 'http://localhost:3001', apiKey: 'gate_sk_...' });

const governed = new GateTool({
  tool: emailTool,          // your existing LangChain Tool
  gate,
  policy: 'outbound-email', // YAML policy ID in Gate
  destination: 'sendgrid.send',
});

try {
  const result = await governed._call(JSON.stringify({ to: 'user@example.com', subject: '...' }));
} catch (err) {
  if (err instanceof GateBlockedError) {
    console.error('Blocked:', err.intentId, err.blockReason);
  }
}
```

## Wrap multiple tools (GateToolkit)

```js
const { GateToolkit } = require('@zehrava/langchain-gate');

const toolkit = new GateToolkit({
  tools: [emailTool, crmTool, slackTool],
  gate,
  policies: {
    'send-email':  'outbound-email',
    'crm-update':  'crm-low-risk',
    '__default__': 'crm-low-risk',   // fallback for unmapped tools
  },
  destinations: {
    'send-email':  'sendgrid.send',
    'crm-update':  'salesforce.api',
    '__default__': 'generic.http',
  },
});

const governedTools = toolkit.getTools(); // drop-in for your agent's tools list
```

## LangGraph integration

Gate provides two primitives for StateGraph:

### `gateNode` — submit intent as a graph node

```js
const { StateGraph, END } = require('@langchain/langgraph');
const { gateNode, gateRouteAfter } = require('@zehrava/langchain-gate');

const graph = new StateGraph({ channels: { ... } });

graph.addNode('submit_to_gate', gateNode({
  gate,
  buildIntent: (state) => ({
    payload: JSON.stringify(state.payload),
    destination: 'salesforce.api',
    policy: 'crm-low-risk',
    recordCount: state.records.length,
  }),
}));

// gateNode writes: state.gateIntentId, state.gateStatus, state.gateBlockReason
```

### `gateRouteAfter` — conditional edge based on Gate's decision

```js
graph.addConditionalEdges('submit_to_gate', gateRouteAfter('gateStatus'), {
  execute:  'run_crm_tool',      // status === 'approved'
  blocked:  'handle_blocked',    // status === 'blocked' | 'duplicate_blocked'
  pending:  'notify_human',      // status === 'pending_approval'
  __end__:  END,
});
```

Full working example: [`examples/langgraph-crm-agent.js`](./examples/langgraph-crm-agent.js)

## Options

### GateTool options

| Option | Type | Default | Description |
|---|---|---|---|
| `tool` | `Tool` | required | LangChain Tool to wrap |
| `gate` | `Gate` | required | Gate SDK client |
| `policy` | `string` | required | Policy ID |
| `destination` | `string` | required | Destination string |
| `toolOptions.idempotencyKeyFn` | `(input) => string` | none | Derive idempotency key from input |
| `toolOptions.onBlocked` | `(id, reason) => any` | throws | Override default throw on block |
| `toolOptions.onPending` | `(id, status, count) => void` | none | Called each poll cycle |
| `toolOptions.autoExecute` | `boolean` | `false` | Report execution result back to Gate |
| `toolOptions.pollIntervalMs` | `number` | `5000` | Polling interval (ms) |
| `toolOptions.timeoutMs` | `number` | `300000` | Max wait for approval (ms) |

## Error classes

```js
const { GateBlockedError, GatePendingError, GateTimeoutError } = require('@zehrava/langchain-gate');

try {
  await governed._call(input);
} catch (err) {
  if (err instanceof GateBlockedError) {
    // err.intentId, err.blockReason
  }
  if (err instanceof GateTimeoutError) {
    // err.intentId, err.timeoutMs — human didn't approve in time
  }
  if (err instanceof GatePendingError) {
    // err.intentId — thrown if you poll manually and it's still pending
  }
}
```

## What Gate does not do

Gate is a **deterministic policy engine**, not an LLM-based moderator.

- It does not understand natural language in payloads
- It does not catch every possible bad action — write explicit policies for what matters
- It protects against mistakes and unauthorized actions, not against a model that modifies the policy files it governs
- Self-hosted only — your credentials never leave your infrastructure

## Links

- [Gate docs](https://zehrava.com/docs/)
- [Gate npm package](https://www.npmjs.com/package/zehrava-gate)
- [Gate GitHub](https://github.com/cgallic/zehrava-gate)
