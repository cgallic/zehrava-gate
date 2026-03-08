# zehrava-gate

**The commit checkpoint between AI agents and production systems.**

Gate sits between agent output and real-world writes — every action goes through `propose → policy → approve → deliver → audit`.

→ [zehrava.com](https://zehrava.com) · [GitHub](https://github.com/cgallic/zehrava-gate)

## Quick start

```bash
# Start the Gate server
npx zehrava-gate --port 4000
```

Options:

```
--port <number>      Port to listen on (default: 4000)
--data-dir <path>    SQLite data directory (default: ./data)
--policy-dir <path>  Policy YAML directory (default: ./policies)
```

## SDK usage

```bash
npm install zehrava-gate
```

```js
const { Gate } = require('zehrava-gate')
// or: import { Gate } from 'zehrava-gate'

const gate = new Gate({
  endpoint: 'http://localhost:4000',
  apiKey: 'YOUR_KEY'
})

const p = await gate.propose({
  payload: './leads.csv',
  destination: 'salesforce.import',
  policy: 'crm-low-risk',
  recordCount: 847
})

// p.status → "pending_approval" | "approved" | "blocked"
if (p.status === 'blocked') {
  console.log(p.blockReason)
}
```

## Self-host

```bash
git clone https://github.com/cgallic/zehrava-gate
cd zehrava-gate/packages/gate-server
npm install
npm start
```

## API

```
POST /v1/agents/register   Register an agent, get an API key
POST /v1/propose           Propose an action for policy evaluation
POST /v1/approve           Approve a pending proposal
POST /v1/reject            Reject a pending proposal
POST /v1/deliver           Deliver an approved proposal (one-time)
GET  /v1/proposals         List proposals (filter by status)
GET  /v1/audit/:id         Get audit trail for a proposal
GET  /health               Server health check
```

## Policy files

Drop YAML files in your `--policy-dir`:

```yaml
id: crm-low-risk
destinations: [salesforce.import, hubspot.contacts]
auto_approve_under: 100
require_approval_over: 100
block_if_terms:
  - "delete all"
  - "drop table"
expiry_minutes: 60
```

## Dashboard

Every proposal lands in the approval queue at `/dashboard`. Approve, reject, view audit trail — no code required.

Try it live: [zehrava.com/dashboard](https://zehrava.com/dashboard)

## License

MIT — free to self-host forever.
