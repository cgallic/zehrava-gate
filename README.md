# Zehrava Gate

**The commit checkpoint between AI agents and production systems.**

→ [zehrava.com](https://zehrava.com) · [npm](https://www.npmjs.com/package/zehrava-gate) · [Live demo](https://zehrava.com/demo)

---

Every agent write — email send, CRM import, database update, file publish — goes through Gate before it lands. Gate evaluates your policy, blocks violations, and holds anything uncertain for human review. No LLM at evaluation time. Deterministic. Audited.

```
propose → policy check → approved | blocked | pending
                                              ↓
                                     human reviews
                                              ↓
                                     approve → one-time deliver
```

## Install

```bash
npm install zehrava-gate
```

## SDK usage

```js
const { Gate } = require('zehrava-gate')
// or: import { Gate } from 'zehrava-gate'

const gate = new Gate({
  endpoint: 'http://localhost:4000',
  apiKey: 'YOUR_KEY'
})

const p = await gate.propose({
  payload: 'Thank you for reaching out — your issue is resolved.',
  destination: 'zendesk.reply',
  policy: 'support-reply',
  recordCount: 1
})

// p.status → "approved" | "blocked" | "pending_approval"
if (p.status === 'blocked') {
  console.log(p.blockReason) // "Payload contains blocked term: refund guaranteed"
}
```

## Run the Gate server

```bash
npx zehrava-gate --port 4000
```

```
--port <number>      Port (default: 4000)
--data-dir <path>    SQLite data directory (default: ./data)
--policy-dir <path>  Policy YAML directory (default: ./policies)
```

## Self-host

```bash
git clone https://github.com/cgallic/zehrava-gate
cd zehrava-gate/packages/gate-server
npm install
npm start
```

## Policy files

Drop YAML files in your `--policy-dir`. Gate evaluates them deterministically — no LLM, no drift.

```yaml
id: support-reply
destinations: [zendesk.reply, intercom.reply, freshdesk.reply]
allowed_types: [text, json]
block_if_terms:
  - "refund guaranteed"
  - "legal action"
  - "sue"
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

## API

```
POST /v1/agents/register   Register an agent → get API key
POST /v1/propose           Propose an action for policy evaluation
POST /v1/approve           Approve a pending proposal
POST /v1/reject            Reject a pending proposal
POST /v1/deliver           Deliver an approved proposal (one-time token)
GET  /v1/proposals         List proposals (filter by status)
GET  /v1/audit/:id         Full audit trail for a proposal
GET  /health               Server health check
```

## Dashboard

Every proposal lands in `/dashboard`. Approve, reject, view audit trail — no code required.

Try it live: [zehrava.com/dashboard](https://zehrava.com/dashboard)

## Why deterministic evaluation?

Gate doesn't use an LLM to evaluate proposals. Your agent may drift across 128k tokens of context — Gate's evaluation is stateless and identical every time. The policy was written by a human when they were thinking clearly. Gate enforces it mechanically, forever.

[Read the full explanation →](https://zehrava.com/blog/why-gate-uses-yaml-not-llms)

## Honest scope

Gate protects against agent mistakes, not rogue agents. If your agent is wired to call Gate, it's already trying to be safe — Gate enforces that it actually is. A fully adversarial agent that skips the SDK call is out of scope. [Full FAQ →](https://zehrava.com/#faq)

## License

MIT — free to self-host forever.
