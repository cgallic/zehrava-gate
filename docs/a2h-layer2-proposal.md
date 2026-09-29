# A2H Layer 2: Authority & Policy — a proposal

| | |
|---|---|
| **Status** | Draft 01 (`zehrava-a2h-l2-draft-01`), proposed for [twilio-labs/Agent2Human](https://github.com/twilio-labs/Agent2Human) |
| **Targets** | A2H v1.2 (POLICY, REVOKE) and v2.0 (DELEGATE, SCOPE, multi-party, conditional defaults) |
| **Builds on** | A2H v1.0 (Layer 1): envelope, AUTHORIZE/RESPONSE, evidence, replay protection |
| **Reference implementation** | [Zehrava Gate](https://github.com/cgallic/zehrava-gate): `POST /v1/a2h/layer2`, tests in `packages/gate-server/test/a2h-layer2.test.js` |
| **Author** | Connor Gallic, Zehrava |

## Abstract

A2H v1.0 standardizes how an agent asks a human for consent to a single
action, and proves the answer. It explicitly defers the next problem to
"Layer 2 … to allow real-world validation": standing policies, delegation,
revocation, scope boundaries, multi-party approval and conditional defaults.

This draft proposes wire formats and semantics for that layer, grounded in
an implementation that already runs those primitives in production code
paths: Zehrava Gate's authority model, which pairs deterministic policy with
signed execution orders and has spoken A2H v1.0 since September 2026
(verified against the twilio-labs reference gateway). Every normative rule
below maps to tested behaviour in Gate.

## 1. The missing role: the Enforcer

Layer 1 has three parties: the **agent**, the **gateway** and the
**principal**. That is enough when every consequential action goes through
AUTHORIZE, because the human is in the loop at decision time.

Layer 2 removes the human from that moment. "Approve all flights under $500"
means that at decision time *no one is asked*. So the question Layer 2 has to
answer is **who evaluates the standing policy, and why can't the agent skip
it?**

An agent cannot enforce a policy against itself: it can misread it, be
prompt-injected past it, or simply not ask. This draft therefore names a
fourth role:

> **Enforcer**: the component that evaluates Layer 2 authority at decision
> time and alone can release the action (for example, by issuing a one-time
> execution credential or by holding the production secret). An enforcer
> MAY be the gateway itself, or a control plane the agent routes its writes
> through.

Layer 2 messages flow **principal → gateway → enforcer**. The agent never
creates, widens or revokes authority; it only benefits from it.

```
 Principal ──(consent + evidence)──▶ Gateway ──POLICY/DELEGATE/REVOKE──▶ Enforcer
                                                                           │
 Agent ──────────── intent ───────────────────────────────────────────────▶│
                                          auto-approve under POLICY ◀──────┤
                                          or AUTHORIZE via gateway  ◀──────┘
```

## 2. Design principles (normative)

1. **Fail closed on anything unenforceable.** An enforcer that receives a
   condition it cannot evaluate exactly MUST reject the message with
   `ERR.UNSUPPORTED_CONDITION`. It MUST NOT drop the condition, because a
   dropped condition silently widens the authority the principal granted.
2. **Granting authority is an AUTHORIZE-grade act.** POLICY and DELEGATE
   MUST carry the principal's consent `evidence` (§1.11 factors), at an
   assurance level at least as high as the approvals the policy will
   bypass.
3. **Authority expires.** POLICY and DELEGATE MUST carry `expires_at`.
   Indefinite standing authority is out of scope.
4. **Evaluate at decision time; revoke prospectively and immediately.**
   Enforcers MUST evaluate authority when the action is decided, not when it
   was cached. After a REVOKE is acknowledged, no new action may rely on the
   revoked authority.
5. **Owner-bound.** A principal can only grant, delegate or revoke their own
   authority. Agents cannot originate Layer 2 messages.
6. **Unknown value means no match.** A policy with an amount bound does not
   match an action whose amount is unknown.
7. **Every use is attributable.** An action released under standing
   authority MUST be recorded with the `policy_id`, and SHOULD be reported
   to the principal (INFORM with `links.policy_ref`).
8. **Idempotent on `message_id`** (as §1.10.2). A replayed message returns
   the original outcome, never a second grant.

## 3. Messages

All messages use the Layer 1 envelope (§1.2). `a2h_version` is `"1.2"`
(`a2h_min_version` `"1.0"`), and the `signature` (detached JWS over JCS,
§1.11.2) covers the whole body including `evidence`.

### 3.1 POLICY: standing approval (v1.2)

```json
{
  "a2h_version": "1.2",
  "type": "POLICY",
  "message_id": "01936f8a-7b2c-7000-8000-00000000a001",
  "principal_id": "did:example:alice",
  "agent_id": "did:web:travel-agent.example.com",
  "created_at": "2026-09-29T12:00:00Z",
  "policy": {
    "effect": "AUTO_APPROVE",
    "action_class": "book_flight",
    "conditions": {
      "max_amount": { "value": 500, "currency": "USD" },
      "window_limits": [
        { "period_sec": 86400, "max_total": { "value": 1500, "currency": "USD" } }
      ]
    },
    "expires_at": "2026-10-29T00:00:00Z",
    "label": "Flights under $500, up to $1,500/day, for a month"
  },
  "evidence": { "factor": "passkey.webauthn.v1", "proof": { "...": "..." } },
  "signature": "<detached JWS>"
}
```

- `effect`: only `AUTO_APPROVE` in v1.2. Deny and require-authorize
  boundaries belong to SCOPE (§3.4).
- `action_class`: matches AUTHORIZE `authorize.action` exactly. In Gate it
  matches the intent's destination (e.g. `stripe.refund`).
- `conditions.max_amount`: per-action ceiling.
- `conditions.window_limits`: rolling cumulative ceilings over actions
  released *under this policy*, excluding blocked, expired and declined
  actions.
- A policy MUST have at least one bound. `AUTO_APPROVE` with no bound is
  rejected.

**Match rule.** An action matches when all of these hold:
- the `action_class` is equal;
- the principal is equal;
- the policy has not expired and has not been revoked;
- every condition evaluates to true.

If any condition cannot be evaluated, there is no match (principle 6).

### 3.2 REVOKE (v1.2)

```json
{
  "a2h_version": "1.2",
  "type": "REVOKE",
  "message_id": "01936f8a-7b2c-7000-8000-00000000a002",
  "principal_id": "did:example:alice",
  "target": { "type": "POLICY", "id": "stap_2c1f..." },
  "reason": "trip cancelled"
}
```

`target.type` is `POLICY` or `DELEGATION`. Pending single interactions keep
using the Layer 1 cancel endpoint (§1.7). Revoking twice returns
`ERR.CONFLICT`, and revoking someone else's authority returns
`ERR.INVALID_PRINCIPAL`.

### 3.3 DELEGATE (v2.0)

```json
{
  "a2h_version": "1.2",
  "type": "DELEGATE",
  "message_id": "01936f8a-7b2c-7000-8000-00000000a003",
  "principal_id": "did:example:alice",
  "delegation": {
    "delegate_id": "did:example:bob",
    "action_class": "stripe.refund",
    "conditions": { "max_amount": { "value": 1000, "currency": "USD" } },
    "expires_at": "2026-10-06T00:00:00Z"
  },
  "evidence": { "factor": "passkey.webauthn.v1", "proof": { "...": "..." } }
}
```

Bob may answer AUTHORIZE requests addressed to Alice within these bounds.
His RESPONSE evidence is his own, and the audit bundle records both the
delegation and his answer. Delegation is not transitive in this draft:
chains are v2.0+ and need an explicit `max_depth`.

### 3.4 SCOPE (v2.0, sketch)

```json
{
  "type": "SCOPE",
  "agent_id": "did:web:crm-agent.example.com",
  "scope": {
    "allow": ["crm.read", "crm.note.create"],
    "require_authorize": ["crm.contact.update", "crm.import"],
    "deny": ["crm.contact.delete", "*"]
  }
}
```

The first matching rule wins, and the default is `deny`. Unlike POLICY,
SCOPE is usually an *organization's* boundary rather than one principal's
preference. It may be pushed by an admin principal or configured on the
enforcer directly. Gate expresses scope today as policy files: a
`destinations` allowlist, `require_approval` and blocking rules.

### 3.5 Multi-party approval (v2.0): AUTHORIZE extension

```json
{
  "type": "AUTHORIZE",
  "authorize": { "action": "finance.payout", "ttl_sec": 3600 },
  "approval": { "required": 2, "approvers": ["did:example:cfo", "did:example:controller", "did:example:ceo"] }
}
```

The interaction reaches ANSWERED only once `required` distinct approvers
have approved. Any one DECLINE ends it as declined. Each approver's
RESPONSE and evidence is retained in the audit bundle.

### 3.6 Conditional defaults (v2.0): AUTHORIZE extension

`on_no_response`: `DECLINE` (default), `DEFER` or `AUTO_APPROVE_IF_POLICY`.
- `DEFER` accepts a late answer instead of hard-expiring.
- `AUTO_APPROVE_IF_POLICY` approves on timeout **only** if an active POLICY
  would have matched anyway.

A timeout on its own is never consent.

## 4. Responses and errors

Success is a `RESULT` responding to the message:

```json
{ "a2h_version": "1.2", "type": "RESULT", "responds_to": "01936f8a-…a001",
  "status": "APPLIED", "result": { "kind": "POLICY", "policy_id": "stap_2c1f…", "state": "ACTIVE" } }
```

A replay returns the same body with `"duplicate": true`. Errors use the
Layer 1 `ERROR` shape. The one new code is **`ERR.UNSUPPORTED_CONDITION`**,
which names the condition(s) the enforcer cannot evaluate, so the gateway can
tell the principal before they rely on it.

## 5. Discovery

Enforcers advertise what they can enforce, so a gateway never offers a
principal a policy that will be rejected:

```json
"layer2": {
  "draft": "zehrava-a2h-l2-draft-01",
  "types": ["POLICY", "REVOKE", "DELEGATE"],
  "endpoint": "/v1/a2h/layer2",
  "conditions": { "currency": ["USD"], "window_period_sec": [86400] }
}
```

## 6. Security considerations

- **Self-granted authority.** This is the central risk: an agent (or a
  prompt injection) that could send POLICY would approve itself. Principle 5
  plus required consent evidence close it. Gate requires a reviewer
  credential and records the evidence with every grant.
- **Widening by omission.** An unknown condition is covered by principle 1.
  An unknown amount is covered by principle 6.
- **Window races.** Concurrent actions can both fit a cumulative limit that
  only one should. Enforcers SHOULD evaluate the window and record the
  release atomically.
- **Replay and staleness.** Reuse Layer 1 `message_id` idempotency and
  `created_at` tolerance (§1.10).
- **Revocation lag.** Cached policies at a gateway can outlive a REVOKE, so
  the enforcer's evaluation is authoritative (principle 4).

## 7. Reference implementation: Zehrava Gate

| This draft | Gate today |
|---|---|
| POLICY `AUTO_APPROVE` + `max_amount` + 24h `window_limits` + `expires_at` | Standing approvals (`lib/authority.js`), checked at propose time; enforced before an execution token can exist |
| REVOKE `POLICY` / `DELEGATION` | `revokeStandingApproval` / `revokeDelegation`; pending interactions via `POST /v1/intents/:id/cancel-approval` (also cancels at the A2H gateway) |
| DELEGATE | Delegations with bounds and expiry; approvals via `on_behalf_of_principal` |
| SCOPE | Policy YAML: `destinations` allowlist, `require_approval`, blocking rules |
| Multi-party | `require_approvals: N` with distinct-approver voting |
| Conditional defaults | `on_no_response: reject \| defer \| auto_approve_if_low_risk` |
| Attributable use | `standing_approval_applied` audit event citing the policy on every auto-approval |
| Fail closed | Unsupported currency, window, condition or effect → `ERR.UNSUPPORTED_CONDITION`; no bound or no expiry → rejected |

Try it:

```bash
curl -X POST http://localhost:4000/v1/a2h/layer2 \
  -H "Authorization: Bearer $GATE_REVIEWER_KEY" -H "Content-Type: application/json" \
  -d '{"a2h_version":"1.2","type":"POLICY","message_id":"msg_1","principal_id":"did:example:alice",
       "policy":{"effect":"AUTO_APPROVE","action_class":"stripe.refund",
                 "conditions":{"max_amount":{"value":50,"currency":"USD"}},
                 "expires_at":"2026-12-31T00:00:00Z"},
       "evidence":{"factor":"passkey.webauthn.v1","proof":{}}}'
```

Conformance: `node packages/gate-server/test/a2h-layer2.test.js` (31 checks).

**Known gaps in Gate:**
- Layer 2 intake is authenticated by a Gate reviewer credential today;
  verifying a gateway-signed POLICY (JWS plus the principal's evidence) is
  the next step.
- The INFORM notice to the principal on each policy use isn't sent yet.
- SCOPE is configuration, not a message.

## 8. Open questions for the A2H community

1. Should the Enforcer role be named in the core spec, or stay an
   implementation detail of "gateway"?
2. Is the `action_class` taxonomy shared with A2H Profiles (`transaction.v1`,
   …), or free-form per deployment?
3. Currency handling: exact-currency only (this draft), or enforcer-side
   conversion with a declared rate source?
4. How should a gateway relay the principal's consent for POLICY: the same
   RESPONSE evidence as an AUTHORIZE, or a dedicated consent ceremony?
5. Should REVOKE propagate from enforcer to gateway (and vice versa), so both
   stop honouring cached authority?
