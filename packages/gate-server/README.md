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
GET  /v1/nonce             Issue a single-use nonce for replay-safe decisions
GET  /.well-known/gate     Capability discovery (auth, channels, TTLs, policy features)
POST /v1/intents/:id/cancel-approval        Cancel a pending/waiting approval
GET  /v1/approval-links/:token              Preview a single-use approval link
POST /v1/approval-links/:token/approve      Approve via a single-use link (no API key)
POST /v1/approval-links/:token/reject       Reject via a single-use link (no API key)
POST /v1/approval-callbacks/:provider       Signed callback for providers that issue their own decision
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

### Approval channels

By default, approvals happen in Gate's own dashboard/API. A policy can instead
route the AUTHORIZE notification to an external channel via `approval_channel`
— the channel only *delivers* the request; the decision itself is always
captured by Gate's own approve/reject/approval-link endpoints, never by the
channel:

```yaml
approval_channel:
  provider: kaicalls        # or: dashboard (default)
  kaicalls:
    to: "+15550001234"       # E.164 approver number
    from_agent_id: "agt_..." # KaiCalls agent/phone line
    voice_call: true         # optional, default true — also places an informational call
```

Set `KAICALLS_API_BASE_URL` and `KAICALLS_API_KEY` to point the KaiCalls
provider at a real account; until both are set, every dispatch is logged and
stubbed — nothing is sent to a real phone. A failed dispatch moves the
intent's `approval_state` to `failed` rather than silently hanging.

A second built-in provider, `a2h`, is a bridge to any [A2H](https://github.com/twilio-labs/Agent2Human)/Ola-compatible
gateway — unlike KaiCalls, the gateway itself issues a signed decision back
to Gate rather than a human deciding inside Gate's own UI:

```yaml
approval_channel:
  provider: a2h
  a2h:
    gateway_url: "https://a2h.example.com/v1/authorize"
    gateway_id: "ola-prod"   # optional, informational
```

Gate sends an AUTHORIZE request carrying the intent, canonical hash, required
factors, and a callback URL; the gateway calls back
`POST /v1/approval-callbacks/a2h` with a signed RESPONSE, verified by the
same generic verifier every provider callback goes through (see below).
Set `A2H_GATEWAY_API_KEY` (outbound auth to the gateway) and
`GATE_PROVIDER_SECRET_A2H` (inbound callback verification) to go live;
until then, AUTHORIZE calls are stubbed.

`POST /v1/propose` also accepts provider-neutral dispatch fields directly,
overriding the policy default for that one request:

```json
{
  "destination": "stripe.refund",
  "policy": "finance-high-risk-kaicalls-demo",
  "approval_provider": "kaicalls",
  "principal_id": "usr_abc123",
  "approval_channel": { "type": "voice_then_sms", "address": "+15550001234" },
  "assurance": { "level": "HIGH", "required_factors": ["voice.ivr.v1", "sms.otp.v1"] }
}
```

For providers that themselves issue a signed decision (rather than just
notifying a human who then decides inside Gate's own dashboard/approval-link
UI), Gate verifies the decision via a signed callback before changing
anything:

```
POST /v1/approval-callbacks/:provider
X-Gate-Provider-Signature: t=<unix-ms>,v1=<hex-hmac-sha256 of "${t}.${rawBody}">
X-Gate-Provider-Delivery-ID: <unique-per-delivery, for replay dedup>
```

Configure the shared secret per provider via `GATE_PROVIDER_SECRET_<PROVIDER>`
(e.g. `GATE_PROVIDER_SECRET_KAICALLS`). The callback is rejected — and nothing
is approved — unless the signature, delivery ID, `responds_to`, canonical
intent hash, expiry, and required evidence factors all check out.

### Risk-tiered approval assurance

A policy can declare which approval factors are required at each computed
risk level, applied automatically unless a `propose` request explicitly
overrides `assurance`:

```yaml
approval_channel:
  provider: kaicalls
assurance:
  low: []                             # no extra evidence required
  medium: [voice.ivr.v1]
  high: [voice.ivr.v1, sms.otp.v1]
  critical: [voice.ivr.v1, sms.otp.v1, passkey.webauthn.v1]
```

Recommended mappings: `low` — chat button or dashboard click is enough;
`medium` — a spoken/IVR confirmation; `high` — IVR plus an OTP; `critical` —
add a strong possession/inherence factor (passkey) once a provider that can
deliver one is configured. If the resolved provider can't satisfy a tier's
required factors, `propose` is rejected with `400 unsupported_factor` before
any dispatch happens — see `lib/approval-providers/index.js` for the
provider capability registry.

## Testing

```bash
npm test                        # full suite: hardening, providers, dispatch,
                                 # callbacks, webhooks, and the E2E harness below
npm run test:e2e                # just the end-to-end approval-provider harness,
                                 # using Gate's built-in mock ("noop") provider —
                                 # no real network calls, safe to run anywhere
npm run test:e2e:kaicalls-staging  # opt-in only — requires GATE_E2E_REAL_PROVIDER=true
                                    # plus KaiCalls staging credentials; never runs
                                    # as part of `npm test` or CI
```

The E2E harness (`test/e2e-approval-provider.test.js`) proves the control-plane
boundary end to end: propose → `pending_approval` → **no execution token is
obtainable yet** → simulate a signed provider callback → approved → execute →
audit includes the approval interaction and evidence bundle — plus a matching
adversarial pass (replay, tampered hash, expired interaction, wrong provider,
insufficient evidence factors) proving none of those can grant execution
access either.

## Dashboard

Every proposal lands in the approval queue at `/dashboard`. Approve, reject, view audit trail — no code required.

Try it live: [zehrava.com/dashboard](https://zehrava.com/dashboard)

## License

MIT — free to self-host forever.
