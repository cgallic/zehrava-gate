# Zehrava Gate

**The safe commit layer for AI agents.**

Your agents can already read, reason, call tools, and generate outputs.  
Gate is the layer that decides whether those outputs are allowed to reach production systems.

```
Agent output → Gate evaluates policy → approved / blocked / pending → deliver once → audit
```

→ [zehrava.com](https://zehrava.com)

---

## The problem

Teams are comfortable letting agents read data, draft outputs, and call low-risk tools.  
They are not comfortable letting agents push CRM updates, send financial payloads, or trigger imports — because there's no governed layer between the agent and the downstream write.

Gate fills that gap.

---

## Quickstart

```bash
# Start a local Gate server
npx @zehrava/gate-server

# Install the SDK
npm install @zehrava/gate
```

```js
const { Gate } = require('@zehrava/gate')

const gate = new Gate({
  endpoint: 'http://localhost:3001',
  apiKey: 'gate_sk_...'
})

// Agent proposes an output
const proposal = await gate.propose({
  payload: './leads.csv',
  destination: 'salesforce.import',
  policy: 'crm-low-risk',
  recordCount: 150
})

console.log(proposal.status)
// pending_approval  ← held for human review (over 100-record threshold)
// approved          ← auto-approved (under threshold)
// blocked           ← policy violation, nothing moves

// Human approves
await gate.approve({ proposalId: proposal.proposalId })

// Gate delivers to the destination — once
const delivery = await gate.deliver({ proposalId: proposal.proposalId })
console.log(delivery.url)
// https://gate.../v1/download/dlv_abc123  ← one-time signed link

// Verify — full audit trail
const verified = await gate.verify({ proposalId: proposal.proposalId })
console.log(verified.auditTrail)
```

---

## Before / After

```
WITHOUT GATE                          WITH GATE

agent.enrichLeads(results)            agent.enrichLeads(results)
      ↓                                     ↓
salesforce.import(leads)              gate.propose({ destination: 'salesforce.import',
      ↓                                               policy: 'crm-low-risk' })
847 records corrupted ✗                     ↓
                                      status: 'pending_approval'
                                            ↓
                                      manager.approve()
                                            ↓
                                      gate.deliver()  →  salesforce.import ✓
                                            ↓
                                      full audit trail logged
```

---

## Why presigned URLs aren't enough

S3 presigned URLs give access to bytes. They don't:

- Verify who produced the payload (agent identity)
- Enforce policy before delivery (destination allowlist, schema, PII check)
- Require human approval for high-risk writes
- Enforce one-time delivery
- Log an immutable audit trail

Gate does all of this. Storage stores bytes. Gate decides whether bytes are allowed to become actions.

---

## Policy

Policies are simple YAML files. No DSL. No giant policy language.

```yaml
# policies/crm-low-risk.yaml
id: crm-low-risk
allowed_types: [csv, json]
destinations: [salesforce.import, hubspot.contacts]
auto_approve_under: 100    # records
require_approval_over: 100
expiry_minutes: 60
```

```yaml
# policies/finance-high-risk.yaml
id: finance-high-risk
require_approval: always
destinations: [netsuite.payout, stripe.payout, quickbooks.batch]
expiry_minutes: 30
delivery: one_time_only
```

```yaml
# policies/support-reply.yaml
id: support-reply
destinations: [zendesk.reply, intercom.reply]
auto_approve_under: 1
block_if_terms:
  - "refund guaranteed"
  - "legal action"
expiry_minutes: 30
```

Included policies: `crm-low-risk`, `finance-high-risk`, `legal-packet`, `internal-publish`, `support-reply`

---

## API reference

### Register an agent

```
POST /v1/agents/register
{ "name": "kai-enrichment-agent", "riskTier": "standard" }
→ { "agentId": "agt_...", "apiKey": "gate_sk_..." }
```

### Propose an output

```
POST /v1/propose
Authorization: Bearer gate_sk_...
{
  "payload": "./leads.csv",
  "destination": "salesforce.import",
  "policy": "crm-low-risk",
  "expiresIn": "1h",
  "recordCount": 150
}
→ {
  "proposalId": "prop_...",
  "status": "pending_approval | approved | blocked",
  "blockReason": null,
  "expiresAt": "..."
}
```

### Get proposal status

```
GET /v1/proposals/:id
→ { proposal + auditTrail[] }
```

### Approve

```
POST /v1/approve
{ "proposalId": "prop_..." }
→ { "status": "approved", "deliveryToken": "dlv_..." }
```

### Reject

```
POST /v1/reject
{ "proposalId": "prop_...", "reason": "PII detected" }
```

### Deliver (one-time)

```
POST /v1/deliver
{ "proposalId": "prop_..." }
→ { "url": "https://.../v1/download/dlv_...", "expiresAt": "..." }
```

### Download (one-time retrieval)

```
GET /v1/download/:token
→ payload file or metadata
   Second request: 410 Gone
```

### Audit trail

```
GET /v1/audit/:proposalId
→ { "events": [ { event_type, actor, metadata, created_at } ] }
```

---

## SDK reference

### JavaScript / TypeScript

```js
const { Gate } = require('@zehrava/gate')

const gate = new Gate({ endpoint, apiKey })

await gate.propose({ payload, destination, policy, expiresIn, recordCount, metadata })
await gate.approve({ proposalId })
await gate.reject({ proposalId, reason })
await gate.deliver({ proposalId })
await gate.verify({ proposalId })
```

### Python

```python
from zehrava_gate import Gate

gate = Gate(endpoint="http://localhost:3001", api_key="gate_sk_...")

gate.propose(payload="./leads.csv", destination="salesforce.import", policy="crm-low-risk")
gate.approve(proposal_id="prop_...")
gate.deliver(proposal_id="prop_...")
gate.verify(proposal_id="prop_...")
```

---

## Examples

- [`examples/hubspot-gate`](examples/hubspot-gate) — CRM update gate with approval queue
- [`examples/finance-gate`](examples/finance-gate) — Finance payout batch with block + one-time delivery
- [`examples/zendesk-gate`](examples/zendesk-gate) — Support reply approval with term blocking

Run any example:
```bash
# Start Gate server
PORT=3001 node packages/gate-server/src/index.js

# Run example
GATE_URL=http://localhost:3001 node examples/hubspot-gate/index.js
```

---

## Deploy

### Local dev
```bash
git clone https://github.com/cgallic/agent-sentinel
cd agent-sentinel
npm install --prefix packages/gate-server
node packages/gate-server/src/index.js
```

### Self-hosted (MIT license — free forever)
```bash
# Copy gate-server to your server
# Set environment variables:
PORT=3001
BASE_URL=https://gate.yourdomain.com
DATA_DIR=/opt/zehrava/data
POLICY_DIR=/opt/zehrava/policies

# Run with PM2
pm2 start packages/gate-server/src/index.js --name zehrava-gate
```

### Cloud
Managed hosting at [zehrava.com](https://zehrava.com)

---

## Competitive positioning

| | Agent runtimes | MCP gateways | Object storage | Zehrava Gate |
|--|--|--|--|--|
| Tool access control | ✓ | ✓ | ✗ | ✗ |
| Output policy enforcement | ✗ | ✗ | ✗ | ✓ |
| Human approval queue | ✗ | ✗ | ✗ | ✓ |
| Downstream write control | ✗ | partial | ✗ | ✓ |
| One-time delivery | ✗ | ✗ | ✗ | ✓ |
| Immutable audit trail | partial | partial | ✗ | ✓ |

Agent runtimes help agents act. MCP gateways govern tool access. Gate governs whether outputs are allowed to commit.

---

## License

MIT — self-deploy is free forever.

[zehrava.com](https://zehrava.com) · [GitHub](https://github.com/cgallic/agent-sentinel)
