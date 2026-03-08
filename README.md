# Zehrava Gate

**Write-path control plane for AI agents.**

→ [zehrava.com](https://zehrava.com) · [npm](https://www.npmjs.com/package/zehrava-gate) · [PyPI](https://pypi.org/project/zehrava-gate/) · [Live demo](https://zehrava.com/demo) · [Docs](https://zehrava.com/docs)

---

Agents can read systems freely. Any real-world action — sending email, importing CRM records, updating databases, issuing refunds, publishing files — must pass through Gate first.

Agents submit an intent. Gate evaluates policy. Optionally requests human approval. Issues a signed execution order. Every step is deterministic, auditable, and fail-closed.

```
intent submitted
  ↓
policy evaluated (YAML, deterministic — no LLM)
  ├── blocked              → terminal
  ├── duplicate_blocked    → terminal (idempotency key matched)
  ├── approved             → auto-approved; eligible for execution
  └── pending_approval     → human review required
        ├── approved        → eligible for execution
        ├── rejected        → terminal
        └── expired         → terminal

approved
  ↓
execution order issued (gex_ token, 15min TTL)
  ↓
worker executes in your VPC
  ↓
outcome reported
  ├── execution_succeeded  → terminal
  └── execution_failed     → terminal
```

## Install

```bash
# JS SDK + server CLI
npm install zehrava-gate

# Python SDK
pip install zehrava-gate
```

## Quickstart

### 1. Start the server

```bash
npx zehrava-gate --port 4000 --policy-dir ./policies
```

### 2. Register an agent

```bash
curl -X POST http://localhost:4000/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "riskTier": "standard"}'
# → { "agentId": "agt_…", "apiKey": "gate_sk_…" }
```

### 3. Submit an intent (JavaScript)

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
// p.blockReason → set if status is "blocked" or "duplicate_blocked"

if (p.status === 'blocked' || p.status === 'duplicate_blocked') {
  throw new Error(p.blockReason || 'Duplicate intent blocked')
}
if (p.status === 'pending_approval') {
  return // wait — do not proceed
}

// approved — request execution order
const order = await gate.execute({ intentId: p.intentId })
// order.execution_token → gex_… — pass to your worker
// order.executionId     → exe_… — track the execution
```

### 4. Submit an intent (Python)

```python
from zehrava_gate import Gate, GateError

gate = Gate(endpoint="http://localhost:4000", api_key="gate_sk_...")

p = gate.propose(
    payload="Thank you — your issue is resolved.",
    destination="zendesk.reply",
    policy="support-reply",
    record_count=1
)

# p["status"] → "approved" | "blocked" | "pending_approval" | "duplicate_blocked"

if p["status"] in ["blocked", "duplicate_blocked"]:
    raise GateError(p["blockReason"])

if p["status"] == "pending_approval":
    return  # wait — do not proceed

# approved — request execution order
order = gate.execute(intent_id=p["intentId"])
# order["execution_token"] → gex_… — pass to your worker
```

## SDK methods

### JavaScript

| Method | Description |
|--------|-------------|
| `gate.propose(opts)` | Submit intent → POST /v1/intents |
| `gate.approve({ intentId })` | Approve pending intent |
| `gate.reject({ intentId, reason })` | Reject pending intent |
| `gate.execute({ intentId })` | Request signed execution order (gex_ token) |
| `gate.verify({ intentId })` | Fetch intent details + decision |
| `gate.registerWebhook({ intentId, url, secret })` | Register state-change webhook |

### Python

| Method | Description |
|--------|-------------|
| `gate.propose(...)` | Submit intent → POST /v1/intents |
| `gate.approve(intent_id=...)` | Approve pending intent |
| `gate.reject(intent_id=..., reason=...)` | Reject pending intent |
| `gate.execute(intent_id=...)` | Request signed execution order (gex_ token) |
| `gate.verify(intent_id=...)` | Fetch intent details + decision |
| `gate.register_webhook(intent_id=..., url=..., secret=...)` | Register state-change webhook |

## Policy files

Drop YAML files in your `--policy-dir`. Evaluated deterministically — no LLM, no drift.

```yaml
id: support-reply
destinations: [zendesk.reply, intercom.reply]
block_if_terms:
  - "refund guaranteed"
  - "legal action"
auto_approve_under: 1
expiry_minutes: 30
```

```yaml
id: crm-low-risk
destinations: [salesforce.import, hubspot.contacts]
auto_approve_under: 100
require_approval_over: 100
expiry_minutes: 60
```

```yaml
id: finance-high-risk
destinations: [stripe.refund, quickbooks.journal]
require_approval: always
expiry_minutes: 15
```

## API routes

```
POST /v1/agents/register        Register agent → get API key (unauthenticated — firewall in prod)
GET  /v1/agents                 List agents
GET  /v1/agents/:id             Get agent
POST /v1/agents/:id/revoke      Revoke agent key
POST /v1/agents/:id/suspend     Suspend agent

POST /v1/intents                Submit intent for policy evaluation
GET  /v1/intents                List intents (filter by status)
GET  /v1/intents/:id            Get intent + decision
POST /v1/intents/:id/approve    Approve pending intent
POST /v1/intents/:id/reject     Reject pending intent
POST /v1/intents/:id/execute    Request execution order (gex_ token, 15min TTL)
GET  /v1/intents/:id/audit      Full audit trail
GET  /v1/intents/:id/decision   Stored policy decision record

GET  /v1/executions/:id         Get execution status
POST /v1/executions/:id/report  Worker reports outcome (succeeded | failed)

GET  /v1/metrics                Aggregated counters
POST /v1/webhooks/register      Register webhook (fires on approved | rejected)

GET  /health                    Server health check
```

V1 backward-compat routes still work: `/v1/propose`, `/v1/approve`, `/v1/reject`, `/v1/deliver`, `/v1/proposals`

## Server options

```
--port <number>      HTTP port (default: 4000)
--data-dir <path>    SQLite + payload storage (default: ./data)
--policy-dir <path>  YAML policy directory (default: ./policies)
```

## Self-host

```bash
git clone https://github.com/cgallic/zehrava-gate
cd zehrava-gate/packages/gate-server
npm install
npm start
```

## Dashboard

Every intent lands in `/dashboard`. Approve, reject, view audit trail — no code required.

Live: [zehrava.com/dashboard](https://zehrava.com/dashboard)

## Why deterministic?

Gate doesn't use an LLM to evaluate intents. YAML policy was written by a human when they were thinking clearly. Gate enforces it mechanically. Same input always produces the same output.

[Read more →](https://zehrava.com/blog/why-gate-uses-yaml-not-llms)

## Honest scope

Gate protects against agent mistakes, not rogue agents. A fully adversarial agent that skips the SDK call is out of scope. [Full FAQ →](https://zehrava.com/#faq)

## License

MIT — free to self-host forever.
