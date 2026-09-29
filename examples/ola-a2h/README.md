# Gate + Twilio Ola (A2H)

**Ola asks the human. Gate decides what the agent may do, and proves it did only that.**

[Twilio Ola](https://www.twilio.com/en-us/blog/developers/introducing-ola-agent-control-communications-channel)
is an agent-to-human channel built on the open
[A2H protocol](https://github.com/twilio-labs/Agent2Human). It reaches a
person over SMS, WhatsApp, voice or a passkey prompt and returns a signed
answer. Zehrava Gate is the policy and execution layer around it:

| | Gate | Ola / A2H gateway |
|---|---|---|
| Should this action need a human? | Deterministic YAML policy, risk scoring | — |
| Reach the human, collect consent | Hands off an A2H `AUTHORIZE` | SMS / WhatsApp / voice / passkey |
| Prove the answer is real | Verifies HMAC webhook + gateway JWS, binds it to the exact intent hash, enforces required factors | Signs the `RESPONSE` |
| Execute | One-time signed execution order (15-min TTL), worker runs in your VPC | — |
| Record | Immutable audit ledger | Interaction log |

## Run it

```bash
npm install                                   # from the repo root, once
node examples/ola-a2h/run-demo.js             # approve/decline in the terminal
node examples/ola-a2h/run-demo.js --browser   # approve/decline on the gateway's page
```

This starts a local A2H gateway ([`mock-gateway.js`](./mock-gateway.js),
standing in for Ola) on `:4100` and Gate on `:4000` with
[`policies/ola-refunds.yaml`](./policies/ola-refunds.yaml). A refund agent
proposes two refunds:

```
■ Refund #1 — agent proposes a $450 Stripe refund
  Gate: pending_approval · risk medium · needs ["a2h.signed_response.v1"]
  Gate → Ola: A2H AUTHORIZE (message_id msg_…, ttl 3599s, to tel:+15555550100)
  Ola → Gate: signed RESPONSE via webhook · verified ["passkey.webauthn.v1","a2h.signed_response.v1","a2h.jws.v1"]
  Gate: approved
  Gate: execution order issued (HTTP 201, one-time token, 15-minute TTL)

■ Refund #2 — agent proposes a $9800 Stripe refund
  Gate: pending_approval · risk high · needs ["a2h.signed_response.v1","passkey.webauthn.v1"]
  …
  Gate: blocked
  Gate: execution refused (HTTP 409) — nothing moves
```

## How the pieces talk

1. **Agent → Gate.** `POST /v1/intents` (or `gate.propose()`). Policy says a
   human is required.
2. **Gate → gateway.** An A2H v1.0 `AUTHORIZE` to `POST {gateway_url}/v1/intent`:
   `message_id`, `agent_id`, `principal_id`, `channel`, `render`,
   `ttl_sec`, `assurance`, a `callback` `{ url, secret }` (secret derived
   per interaction, so a gateway never holds a key for another gateway's
   requests), and the intent id and canonical intent hash under `params.gate`.
3. **Human decides** on the channel the gateway picked.
4. **Gateway → Gate.** Either a webhook `RESPONSE` to
   `POST /v1/approval-callbacks/a2h` signed with `X-A2H-Signature`, or Gate
   polls `GET /v1/status/{interaction_id}`. Both work with no webhook set up.
5. **Gate verifies:** webhook HMAC and freshness, `X-A2H-Delivery-ID`
   replay, the gateway's detached JWS against `jwks_uri`, `responds_to` →
   the original `message_id`, the gateway `interaction_id`, expiry, and the
   policy's required factors. Only a verified approval unlocks
   `POST /v1/intents/:id/execute`. A verified decline always blocks.

Cancelling in Gate (`POST /v1/intents/:id/cancel-approval`) also sends
`POST /v1/cancel/{interaction_id}` to the gateway, so the human stops being
asked. An A2H `ERROR` (`ERR.EXPIRED`, …) closes the approval without
approving.

## Point it at a real gateway

```yaml
# your policy
approval_channel:
  provider: a2h
  a2h:
    gateway_url: "https://<your-ola-or-a2h-gateway>"
    agent_id: "did:web:your-agent.example.com"
    channel: { type: sms, address: "tel:+1…" }
    jwks_uri: "https://<gateway>/.well-known/jwks.json"   # if it signs RESPONSEs
    require_jws: true
```

```bash
export A2H_GATEWAY_API_KEY=…         # sent as X-A2H-API-Key and Bearer (auth: api_key|bearer to pick one)
export GATE_PROVIDER_SECRET_A2H=…    # master webhook secret; each AUTHORIZE carries a callback.secret derived from it
export BASE_URL=https://gate.yourco.com   # an https:// BASE_URL turns on webhooks (A2H requires HTTPS); otherwise Gate polls
```

**Twilio's reference gateway**
([`twilio-labs/Agent2Human/demo`](https://github.com/twilio-labs/Agent2Human/tree/main/demo))
is poll-only and doesn't sign responses. Use `auth: bearer` and
`A2H_GATEWAY_API_KEY=a2h_demo_secret`, and don't require
`a2h.signed_response.v1` / `a2h.jws.v1`: its passkey approvals arrive as
`passkey.webauthn.v1` over polling. We tested Gate against it with a real
WebAuthn passkey (Chromium virtual authenticator): an approval issues an
execution order, and a decline blocks the intent. One caveat: at the
version we tested, the reference gateway sends an empty passkey `proof`
object, so rely on your production gateway for passkey evidence.

## Evidence factors

`assurance` in the policy lists what Gate must see before it treats an
answer as an approval:

| Factor | Meaning |
|---|---|
| `passkey.webauthn.v1`, `otp.sms.v1`, `otp.email.v1`, `push.v1`, `voice.ivr.v1` | The human factor the gateway attests to (`RESPONSE.evidence.factor`) |
| `a2h.signed_response.v1` | Gate authenticated the RESPONSE: an HMAC-verified webhook, or a valid gateway JWS |
| `a2h.jws.v1` | Gate verified the gateway's JWS against its published keys (non-repudiable) |

An unsigned poll result never earns the `a2h.*` factors, so a policy that
requires them fails closed against a gateway that doesn't sign.

## Files

- [`run-demo.js`](./run-demo.js): the walkthrough above
- [`mock-gateway.js`](./mock-gateway.js): a zero-dependency A2H v1.0 gateway
  (discovery, JWKS, intent, status, cancel, signed webhooks, approval page).
  Also used by `packages/gate-server/test/a2h-spec-conformance.test.js`.
- [`policies/ola-refunds.yaml`](./policies/ola-refunds.yaml): the policy
