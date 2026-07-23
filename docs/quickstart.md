# Quickstart

Goal: a governed write in under 5 minutes.

## 0. Try the demo (no config)

```bash
npx zehrava-gate demo
```

## 1. Scaffold and start a server

```bash
npx zehrava-gate init          # creates ./policies with 3 starter policies + .env
npx zehrava-gate --port 4000 --policy-dir ./policies
```

Or with Docker:

```bash
docker compose up              # from a checkout of this repo
```

## 2. Register an agent

```bash
curl -X POST http://localhost:4000/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "riskTier": "standard"}'
# → { "agentId": "agt_…", "apiKey": "gate_sk_…" }
```

(Registration is unauthenticated by design for local dev — firewall it in
production.)

## 3. Submit an intent

JavaScript:

```js
const { Gate } = require('zehrava-gate')

const gate = new Gate({ endpoint: 'http://localhost:4000', apiKey: 'gate_sk_...' })

const p = await gate.propose({
  payload:      'Thank you — your issue is resolved.',
  destination:  'zendesk.reply',
  policy:       'support-reply',
  recordCount:  1
})
// p.status → "approved" | "blocked" | "pending_approval" | "duplicate_blocked"
```

Python:

```python
from zehrava_gate import Gate

gate = Gate(endpoint="http://localhost:4000", api_key="gate_sk_...")
p = gate.propose(payload="...", destination="zendesk.reply",
                 policy="support-reply", record_count=1)
```

## 4. Execute only what Gate approved

```js
if (p.status === 'approved') {
  const order = await gate.execute({ intentId: p.intentId })
  // order.execution_token → gex_… (15-minute TTL) — hand to your worker
  // your worker executes, then reports the outcome:
  // POST /v1/executions/:id/report { status: "succeeded" }
}
```

`pending_approval` means stop and wait — a human decides in the dashboard
(or via a configured approval channel), and you can poll
`gate.verify({ intentId })` or register a webhook for the state change.

## Next steps

- [Policy reference](./policy-reference.md) — tune what auto-approves,
  what blocks, and what needs a human
- [MCP server](../packages/mcp-gate/README.md) — give Claude (or any MCP
  host) governed write primitives
- [LangChain wrapper](../packages/langchain-gate/README.md) — wrap
  existing tools with Gate policy
