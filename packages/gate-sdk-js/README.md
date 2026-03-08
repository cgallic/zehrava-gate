# @kaicmo/gate

**The commit checkpoint between AI agents and production systems.**

Every agent write goes through the same path: `propose → policy → approve → deliver → audit`. No direct commits. No silent writes.

→ [zehrava.com](https://zehrava.com) · [GitHub](https://github.com/cgallic/zehrava-gate)

## Install

```bash
npm install @kaicmo/gate
```

## Quickstart

Run the Gate server locally:

```bash
npx zehrava-gate --port 4000
```

Use the SDK:

```js
const { Gate } = require('@kaicmo/gate')

const gate = new Gate({
  endpoint: 'http://localhost:4000',
  apiKey: 'YOUR_KEY'   // from POST /v1/register
})

// Propose an action — Gate evaluates policy before anything writes
const p = await gate.propose({
  payload:     './leads.csv',
  destination: 'salesforce.import',
  policy:      'crm-low-risk',
  recordCount: 847
})

console.log(p.status)
// "pending_approval" — 847 > 100 threshold
// "approved"         — auto-approved by policy
// "blocked"          — destination not in allowlist

// Deliver exactly once (after approval)
await gate.deliver({ proposalId: p.proposalId })
// Second call returns 409 — one-time delivery enforced
```

## API

```js
gate.propose({ payload, destination, policy, recordCount, metadata })
gate.approve({ proposalId })
gate.reject({ proposalId, reason })
gate.deliver({ proposalId })
gate.verify({ proposalId })
```

## What Gate governs

Gate does not validate business logic. It answers four questions before any write reaches production:

1. **Who sent this?** — verified agent identity
2. **Where is it going?** — destination allowlists
3. **Should it be allowed?** — shared policy rules (YAML)
4. **Who approved it?** — centralized approval queue + audit trail

## Policy example

```yaml
id: crm-low-risk
destinations: [salesforce.import, hubspot.contacts]
auto_approve_under: 100
require_approval_over: 100
expiry_minutes: 60
delivery: one_time
```

Policies are shared YAML files. Same rules across every agent, every framework.

## Why not just use LangSmith / Guardrails / AgentOps?

Those tools are observability and content safety — they tell you what happened or validate LLM outputs. Gate governs the **write path**: whether an agent output is allowed to become a production write, and who approved it.

## Self-hosting

Gate is MIT licensed and self-hostable. Run it on your own infrastructure:

```bash
git clone https://github.com/cgallic/zehrava-gate
cd zehrava-gate/packages/gate-server
npm install
npm start
```

## Links

- **Live demo**: [zehrava.com/demo](https://zehrava.com/demo)
- **Approval dashboard**: [zehrava.com/dashboard](https://zehrava.com/dashboard)
- **Docs**: [zehrava.com](https://zehrava.com)
- **Server package**: [zehrava-gate on npm](https://npmjs.com/package/zehrava-gate)
