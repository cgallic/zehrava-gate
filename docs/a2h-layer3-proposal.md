# A2H Layer 3: Execution & Attestation — a proposal

| | |
|---|---|
| **Status** | Draft 01 (`zehrava-a2h-l3-draft-01`), proposed for [twilio-labs/Agent2Human](https://github.com/twilio-labs/Agent2Human) |
| **Targets** | A2H v1.3 (EXECUTE, ATTEST, RESULT `proof`, audit bundle v2) |
| **Builds on** | A2H v1.0 (Layer 1): AUTHORIZE/RESPONSE, evidence, §1.11.8 audit bundle. Layer 2 draft (`zehrava-a2h-l2-draft-01`): the Enforcer role, fail-closed principles |
| **Reference implementation** | [Zehrava Gate](https://github.com/cgallic/zehrava-gate): `POST /v1/intents/:id/execute`, `POST /v1/executions/:id/report`, `lib/evidence.js` (partial today; see §8) |
| **Author** | Connor Gallic, Zehrava |

## Abstract

Layer 1 proves that a human consented to a described action. Layer 2 governs
standing authority so the human is not asked every time. Neither says
anything about what then happened. Between "APPROVE" and "Your purchase is
complete" there is a gap the current spec fills with trust: the agent (or
its worker) does something, and reports something.

This draft closes that gap with three bindings: **consent → grant** (a
single-use execution credential bound to the exact approved intent),
**grant → request** (the executor commits, under its own key, to the digest
of the request it sent and the response it got), and **request → verdict**
(the enforcer compares the attestation to the consent and signs a verdict
that a principal or auditor can verify offline). The RESULT the human
receives carries that proof instead of a bare status string.

The thesis we tested was "nothing yet proves that what executed is exactly
what was consented to". It holds, with one correction that shapes the whole
design: Layer 3 cannot prove what happened in the outside world. It can
prove that a keyed party committed to a specific claim, that the claim
matches the consent, and that nobody can quietly change either afterwards.
That is weaker than a proof of execution and much stronger than a status
field, and it is what an auditor actually needs.

## 1. The problem: four ways "approved" and "done" drift apart

All four occur in a Layer 1+2 deployment that follows the spec exactly.

1. **Approved-then-altered payload.** The human approves "refund $40 to
   order 123". Between approval and execution the payload is edited (a
   bug, a retry with different arguments, a prompt injection). Layer 1
   binds consent to a `message_id`, not to the bytes that will be sent.
2. **Replayed or stretched approval.** One APPROVE is used for two
   executions, or for one execution an hour later under different market
   conditions. §1.10 stops RESPONSE replay at the gateway, but nothing
   limits how many times an agent *acts* on a RESPONSE it legitimately
   received, or for how long.
3. **Execution before or without approval.** The agent calls the
   destination directly, then sends AUTHORIZE for the record, or never
   sends it. If the agent holds the production credential, consent is
   advisory.
4. **Executor lies about the outcome.** The worker reports `succeeded`.
   Nothing ties that word to a request digest, a response, or a key.
   Gate's own FAQ states this plainly: "the worker reports success, but
   Gate never verified the execution".

Failure modes 1 and 2 are about binding consent to a specific request.
Failure mode 3 is about custody. Failure mode 4 is about attestation. Layer
3 addresses each with one primitive and keeps the rest out of scope.

## 2. Roles

Layer 2 introduced the **Enforcer**. Layer 3 adds one more:

> **Executor**: the component that performs the side effect against the
> destination and holds a signing key registered with the enforcer. The
> executor MAY be the enforcer itself (*enforcer custody*: the enforcer
> holds or brokers the production credential and makes the call), or a
> worker inside the operator's environment (*executor custody*). An agent
> SHOULD NOT be the executor of a consequential action; when it is, the
> attestation is worth exactly as much as the agent's honesty.

```
 Principal ──RESPONSE(APPROVE)──▶ Gateway ──consent evidence──▶ Enforcer
                                                                  │ EXECUTE (grant: single-use, bound to intent hash)
                                                                  ▼
                                                              Executor ──request──▶ Destination
                                                                  │ ATTEST (request digest, response digest, signed)
                                                                  ▼
                                                              Enforcer  verify → VERDICT → audit bundle
                                                                  │
 Principal ◀──RESULT + proof──── Gateway ◀────────────────────────┘
```

The agent proposes and observes. It never holds the grant's credential
when custody is with the enforcer, and it never produces the attestation.

## 3. Design principles (normative)

1. **Consent is spent, not held.** An approved intent MUST yield at most
   one EXECUTE grant, and a grant MUST be accepted at most once. Once a
   grant is issued, the consent evidence is consumed; a second grant
   requires a new AUTHORIZE.
2. **The grant names the request.** A grant MUST carry the
   `approved_intent_hash` from the consent evidence and a `request_digest`
   over the canonical request the executor is permitted to send. An
   executor MUST refuse to send a request whose digest differs.
3. **Short-lived.** A grant MUST carry `expires_at`; enforcers SHOULD
   default to 15 minutes and MUST cap at the value they advertise.
4. **Custody decides what an attestation proves.** Enforcers MUST advertise
   whether custody is `enforcer` or `executor` for each destination. Under
   executor custody the enforcer MUST bind the grant to a registered
   executor key (`aud`), so a leaked grant is useless without the key.
5. **Attest the claim, not the story.** An ATTEST MUST contain the digest
   of the request actually sent and of the response actually received,
   both computed by the executor before any interpretation. Free-text
   results are informational only.
6. **The enforcer verifies, then signs a verdict.** A verdict is one of
   `MATCH`, `MISMATCH` or `UNATTESTED`. `MISMATCH` MUST be surfaced to the
   principal and MUST NOT be reported as success. `UNATTESTED` (legacy
   report without attestation) MUST be labelled as such in every bundle.
7. **Outcomes are append-only.** After a terminal ATTEST, further reports
   for the same grant MUST be rejected (`ERR.CONFLICT`) and recorded, never
   merged. A report of `UNKNOWN` (timeout, connection lost) is a valid
   terminal outcome and MUST NOT be coerced into success or failure.
8. **Only digests leave the executor.** Response bodies may carry the
   destination's data; the protocol carries hashes and bounded hints.
9. **Verifiable offline.** Every signature in the bundle MUST be
   verifiable with published public keys (JWKS). Symmetric MACs are
   acceptable for the enforcer's internal storage, not for the bundle.

## 4. Messages

All messages use the Layer 1 envelope (§1.2), `a2h_version` `"1.3"`,
`signature` as a detached JWS over the JCS-canonical body (§1.11.2).

### 4.1 EXECUTE: the execution grant (enforcer → executor)

```json
{
  "a2h_version": "1.3",
  "type": "EXECUTE",
  "message_id": "01936f8a-7b2c-7000-8000-00000000b001",
  "interaction_id": "itx_9f2c…",
  "responds_to": "01936f8a-…a0f1",
  "agent_id": "did:web:travel-agent.example.com",
  "principal_id": "did:example:alice",
  "grant": {
    "grant_id": "exe_4c1d…",
    "approved_intent_hash": "sha256:8a1f…",
    "consent_ref": { "interaction_id": "itx_9f2c…", "response_jws": "<from RESPONSE>" },
    "request": {
      "destination": "stripe.refund",
      "action": "stripe.refund",
      "payload_hash": "sha256:5b90…",
      "idempotency_key": "exe_4c1d…"
    },
    "request_digest": "sha256:e77a…",
    "aud": "did:web:worker-7.ops.example.com",
    "custody": "executor",
    "issued_at": "2026-09-29T12:00:00Z",
    "expires_at": "2026-09-29T12:15:00Z",
    "credential": "gex_…"
  },
  "signature": "<detached JWS, enforcer key>"
}
```

- `request_digest` = `sha256(JCS(grant.request))`. `grant.request` MUST
  NOT contain credentials or authorization headers. Action-specific fields
  come from Profiles (§1.5); the base set is `destination`, `action`,
  `payload_hash`, `idempotency_key`.
- `idempotency_key` defaults to `grant_id`. Executors MUST pass it to
  destinations that support one, so a network retry cannot double-apply.
- `credential` is a bearer secret and MUST be delivered once over TLS,
  stored hashed by the enforcer, and never included in read endpoints.
- `responds_to` is the AUTHORIZE `message_id`, so the grant threads into
  the same interaction as the consent.

### 4.2 ATTEST: the executor's commitment (executor → enforcer)

```json
{
  "a2h_version": "1.3",
  "type": "ATTEST",
  "message_id": "01936f8a-7b2c-7000-8000-00000000b002",
  "responds_to": "01936f8a-…b001",
  "attestation": {
    "grant_id": "exe_4c1d…",
    "executor_id": "did:web:worker-7.ops.example.com",
    "request_digest": "sha256:e77a…",
    "sent_at": "2026-09-29T12:00:41Z",
    "response": {
      "status": "SUCCEEDED",
      "http_status": 200,
      "response_digest": "sha256:0c3e…",
      "receipt": { "type": "stripe.refund_id", "value": "re_3Q…" },
      "hint": "{\"id\":\"re_3Q…\",\"status\":\"succeeded\""
    },
    "received_at": "2026-09-29T12:00:42Z"
  },
  "signature": "<detached JWS, executor key (kid registered with enforcer)>"
}
```

- `status` ∈ `SUCCEEDED | FAILED | UNKNOWN`. `UNKNOWN` means the request
  was sent and no trustworthy response arrived.
- `response_digest` = `sha256(http_status || 0x00 || raw body bytes)`.
- `receipt` is an opaque destination identifier the enforcer stores but
  cannot verify. It is what a human reconciles against later.
- `hint` is optional, bounded (≤ 256 bytes) and MUST be redacted by the
  executor's own policy before inclusion.
- Authentication: the ATTEST is presented with the grant `credential` as
  bearer AND signed with the executor key. Both are required under
  executor custody; under enforcer custody the enforcer signs as executor.

### 4.3 VERDICT (enforcer, embedded in RESULT and bundle)

```json
{
  "verdict": "MATCH",
  "grant_id": "exe_4c1d…",
  "approved_intent_hash": "sha256:8a1f…",
  "request_digest": "sha256:e77a…",
  "attestation_hash": "sha256:9d0b…",
  "outcome": "SUCCEEDED",
  "checked": ["consent_signature", "grant_binding", "grant_single_use", "executor_key", "request_digest", "time_window"],
  "reasons": [],
  "decided_at": "2026-09-29T12:00:42Z",
  "signature": "<detached JWS, enforcer key>"
}
```

`MISMATCH` carries `reasons` such as `request_digest_mismatch`,
`executor_unknown`, `grant_expired`, `attest_after_terminal`.

### 4.4 RESULT with proof (agent/enforcer → principal, via gateway)

Layer 1's RESULT is kept; Layer 3 adds `params.proof`:

```json
{
  "a2h_version": "1.3",
  "type": "RESULT",
  "responds_to": "01936f8a-…a0f1",
  "render": { "body": "Refund of $40.00 sent to order 123. Ref re_3Q… Proof: 9d0b…" },
  "params": {
    "status": "EXECUTED",
    "proof": {
      "verdict": "MATCH",
      "bundle_ref": "https://gate.example.com/v1/audit/int_7c…/bundle",
      "bundle_hash": "sha256:c4a2…",
      "receipt": { "type": "stripe.refund_id", "value": "re_3Q…" }
    }
  }
}
```

A RESULT for a `MISMATCH` or `UNKNOWN` outcome MUST set `params.status` to
`DISPUTED` or `UNKNOWN`, never `EXECUTED`. The human will not verify a JWS
on SMS; the point is that the enforcer has *committed* a bundle hash to
the principal, so the bundle cannot later be rewritten without detection.

## 5. Verification algorithm

Input: an audit bundle (§6) and the JWKS of the gateway, enforcer and
executor. Output: `MATCH | MISMATCH(reasons) | UNATTESTED`.

1. **Consent.** Verify `consent.response_jws` with the gateway key. Check
   `decision == APPROVE`, and `responds_to == authorize.message_id`.
   Recompute `approved_intent_hash = sha256(JCS(intent_canonical))` from
   the bundle's `intent` object; it MUST equal the hash inside the signed
   consent.
2. **Grant binding.** Verify `grant.signature` with the enforcer key.
   `grant.approved_intent_hash` MUST equal step 1's hash.
   `grant.request_digest` MUST equal `sha256(JCS(grant.request))`, and
   `grant.request.payload_hash` MUST equal `intent.payload_hash`.
   `expires_at − issued_at` MUST be ≤ the enforcer's advertised maximum.
3. **Single use.** The bundle MUST contain exactly one grant for the
   consent and at most one terminal attestation for the grant. Extra
   attestations are listed under `rejected_reports` and cause `MISMATCH`.
4. **Executor.** If no attestation: `UNATTESTED`. Otherwise verify
   `attestation.signature` with the executor key named by `kid`; the
   executor MUST be one the enforcer lists in `executors` and, under
   executor custody, MUST equal `grant.aud`.
5. **Request equality.** `attestation.request_digest == grant.request_digest`.
6. **Time.** `grant.issued_at ≤ sent_at ≤ received_at ≤ grant.expires_at`,
   with the enforcer's advertised tolerance.
7. **Verdict integrity.** Verify `verdict.signature` with the enforcer key
   and check its fields equal the values recomputed above. If the recorded
   verdict is `MATCH` but any step fails, the result is `MISMATCH` with
   `verdict_forged` appended.

Any failing step short-circuits to `MISMATCH`; the verifier reports every
reason it found before stopping.

## 6. Audit bundle v2 (extends §1.11.8)

```json
{
  "audit_bundle": {
    "version": "a2h-audit.v2",
    "interaction_id": "itx_9f2c…",
    "intent": { "intent_id": "int_7c…", "destination": "stripe.refund", "action": "stripe.refund",
                "payload_hash": "sha256:5b90…", "policy_id": "finance-refunds", "estimated_value_usd": 40, "...": "…" },
    "consent": { "request_jws": "<AUTHORIZE JWS>", "response_jws": "<RESPONSE JWS>",
                 "evidence": { "factor": "passkey.webauthn.v1", "proof": { "…": "…" } },
                 "approved_intent_hash": "sha256:8a1f…", "policy_ref": null },
    "grant": { "…EXECUTE.grant without credential…", "signature": "…" },
    "attestation": { "…ATTEST.attestation…", "signature": "…" },
    "rejected_reports": [],
    "verdict": { "…§4.3…" },
    "events": [ { "type": "approved", "at": "…" }, { "type": "execution_requested", "at": "…" } ],
    "keys": { "gateway_jwks_uri": "…", "enforcer_jwks_uri": "…", "executors": [ { "kid": "worker-7", "jwk": { "…": "…" } } ] },
    "bundle_hash": "sha256:c4a2…",
    "signature": "<detached JWS over JCS(bundle minus signature), enforcer key>"
  }
}
```

`bundle_hash` is what the RESULT commits to the principal. A Layer 2
auto-approval replaces `consent.response_jws` with the POLICY message and
sets `policy_ref`; the algorithm in §5 then verifies the POLICY signature
and match rule in step 1.

## 7. Errors and discovery

New codes: `ERR.CONSENT_MISMATCH` (grant refused: evidence no longer binds
to the intent), `ERR.GRANT_CONSUMED`, `ERR.GRANT_EXPIRED`,
`ERR.EXECUTOR_UNKNOWN`, `ERR.ATTEST_MISMATCH`. Duplicate ATTEST with an
identical body returns the original verdict with `"duplicate": true`
(§1.10.2); a different body is `ERR.CONFLICT` and is recorded.

```json
"layer3": {
  "draft": "zehrava-a2h-l3-draft-01",
  "types": ["EXECUTE", "ATTEST"],
  "max_grant_ttl_sec": 900,
  "custody": { "stripe.refund": "enforcer", "salesforce.import": "executor" },
  "attestation_algs": ["ES256", "EdDSA"],
  "jwks_uri": "https://gate.example.com/.well-known/jwks.json",
  "audit_bundle": { "version": "a2h-audit.v2", "endpoint": "/v1/audit/{interaction_id}/bundle" }
}
```

### What stays out

- **Proof that the destination did it.** Only the destination can attest
  to its own state. Layer 3 records receipts; it does not verify them.
- **Executor code integrity** (TEEs, remote attestation). Compatible as an
  extra `attestation.platform` field, out of scope here.
- **Checkpoint/resume of agent runs.** Gate's Run Ledger is useful runtime
  machinery, but it is the agent's continuity problem, not the human's
  consent problem. The one rule that crosses over is principle 1 plus the
  `idempotency_key`: at most one side effect per consent.
- **Credential provisioning protocols.** Custody is advertised, not
  standardized.

## 8. Security considerations

- **Compromised executor.** It can lie about the response, not about the
  request: a fabricated ATTEST still has to carry the grant's
  `request_digest`, so the worst case is "claimed success for the approved
  request", which the receipt and destination records expose. Enforcer
  custody removes the executor as a separate trust boundary.
- **Grant leakage.** The grant is a bearer secret. Bind it to `aud` under
  executor custody, hash it at rest, keep it out of GET responses, and cap
  TTL. A grant without the executor key MUST be rejected.
- **Enforcer as single point of trust.** The verdict is the enforcer's
  opinion. Three mitigations: the consent is gateway-signed (the enforcer
  cannot forge approval), the attestation is executor-signed (the
  enforcer cannot forge execution), and the bundle hash is committed to
  the principal in the RESULT (the enforcer cannot rewrite history).
- **Digest collisions in canonicalization.** `grant.request` MUST be
  JCS-canonical and MUST include every field the destination will read.
  Profiles define the field set; an executor that adds fields outside it
  has changed the request and MUST fail the digest check.
- **Data exposure.** Response bodies stay with the executor; the enforcer
  sees digests, status and a bounded, executor-redacted hint.
- **Timing.** Executor clocks are untrusted. The enforcer's receipt time is
  authoritative; `sent_at`/`received_at` are checked with tolerance.
- **Race between two reports.** Terminal-state transitions MUST be atomic
  (compare-and-set on the grant's status) so two concurrent ATTESTs cannot
  both be accepted.
- **Unknown outcomes.** A timeout after the request was sent may have
  succeeded. `UNKNOWN` MUST flow to the principal as unknown; a retry MUST
  reuse the `idempotency_key` and needs a new grant.

## 9. Reference implementation: Zehrava Gate

What Gate does today (file paths verified against `packages/gate-server/src`):

| This draft | Gate today |
|---|---|
| Consent bound to intent (`approved_intent_hash`) | `lib/evidence.js` `canonicalIntentPayload` → `canonicalIntentHash`; HS256 detached JWS via `lib/signing.js` `signDetached`; stored in `approval_evidence` |
| Grant refused on drift (principle 2, `ERR.CONSENT_MISMATCH`) | `routes/executions.js` `POST /v1/intents/:id/execute` calls `verifyApprovalEvidence`; mismatch → 409 `approval_evidence_invalid` and `evidence_verification_failed` event |
| Consent spent once (principle 1) | `consumeApprovalEvidence` sets `consumed_at`; `executions.intent_id` is `UNIQUE`; `executing`/`succeeded` → 409, `scheduled` → same order returned |
| Short-lived grant (principle 3) | `gex_` token via `lib/crypto.js` `generateExecutionToken`, 15 min (`expires_at`), advertised as `max_execution_ttl_sec: 900` in `index.js` `buildCapabilities` |
| Enforcer custody | `proxy/vault.js` `fetchCredential` (env / 1Password / HashiCorp / AWS), `buildAuth` injects the secret; `proxy/executor.js` `executeIntent` makes the call; secret never logged (only a 12-char hash) |
| Executor custody | `runner_exec` mode: worker fetches the order via SDK `execute()` and reports via `POST /v1/executions/:id/report` (MCP `gate_send_result` passes `execution_token` as bearer) |
| Outcome recorded | `/report` stores `status`, `executed_at`, `result`; `execution_succeeded`/`execution_failed` events; Run Ledger `EXECUTION_SUCCEEDED` with `sideEffectKey` |
| Audit bundle | `routes/audit.js` `GET /v1/audit/:id` returns events plus `approval_evidence` |
| Offline-verifiable signatures | `lib/a2h-protocol.js` has ES256/EdDSA `signDetachedJws`/`verifyDetachedJws` with JWKS, used to verify *gateway* RESPONSEs |
| Sealed, verifiable record (pattern) | `lib/runs/checkpoint.js` `seal`/`verify` recompute a sealed hash over the event set |

Concrete gaps (each verified in code):

1. **Execution orders are signed, but only symmetrically.** *Fixed in
   this release:* the order now carries `approved_intent_hash` and
   `payload_hash` plus Gate's detached signature (`order_signature`), and a
   worker can check it with `POST /v1/execution-orders/verify`. *Still
   open:* the signature is HS256 with a server-held secret, so only Gate
   can verify it (M1: ES256 + JWKS), and there is no `request_digest` or
   `aud` yet (M0).
2. **`/report` is a claim, not an attestation.** *Fixed in this release:*
   only the execution token, the proposing agent's key or a reviewer's key
   can report, and a reported outcome can no longer be rewritten (409
   `execution_already_reported`). *Still open:* `result` is free-form and
   never compared to the approved intent (M0 attestation + verdict).
3. **gate_exec now presents the grant.** *Fixed in this release:* `/report`
   accepts the token in the body, as `proxy/executor.js` sends it.
4. **Executed bytes are not checked against `payload_hash`.**
   `executeIntent` sends `intent.payloadContent` (read from disk in
   `routes/approvals.js` `executeApproveDecision`) without hashing it
   against `execOrder.payload_hash`. Worse, `routes/proposals.js` sets
   `payload_hash` only for inline payloads; a file-path payload gets
   `payload_hash: null`, so the intent hash does not bind the file at all.
5. **Grant custody hygiene.** *Fixed in this release:* the token is
   returned only to the caller that requested the execution, never on
   `GET /v1/executions/:id` or in report responses, and only the proposer
   or a reviewer can request it. *Still open:* it is stored in plaintext
   (M1: hash at rest).
6. **No RESULT to the principal.** `lib/approval-providers/a2h.js`
   implements `sendAuthorize`, `getStatus`, `cancel` only.
7. **Audit is neither signed nor tamper-evident.** `lib/audit.js` writes
   plain rows; no hash chain, no signature over `GET /v1/audit/:id`.
   Gate's only signature is HS256 with a DB-stored secret, so nothing is
   verifiable outside the server.
8. **Side-effect key is per execution, not per action.** `executions.js`
   calls `sideEffectKey(action, destination, { executionId })`, so the Run
   Ledger cannot recognise the same action applied twice.

## 10. Implementation plan for Gate

**M0 — ship in a day: attested outcome + signed bundle.**

- `lib/attestation.js` (new): `canonicalRequest(execution)` and
  `requestDigest`; `buildGrant(execution, evidence)` signed with
  `signDetached`; `verifyAttestation({ execution, attestation })` returning
  `{ verdict, reasons }`; `buildAuditBundle(intentId)` + `signBundle`;
  `verifyAuditBundle(bundle, secret)` for tests.
- `lib/db.js`: `ALTER TABLE executions ADD` `request_digest`,
  `attestation_json`, `verdict`, `verdict_reasons`, `executor_id`.
- `routes/executions.js`: add `request_digest` to the signed order
  (`approved_intent_hash`, `payload_hash` and the signature already
  shipped). In `/report` (terminal-state guard already shipped): accept an
  optional `attestation`; require the
  `gex_` bearer when an attestation is present; compute verdict; on
  `MISMATCH` set proposal status `disputed`, log `attestation_mismatch`,
  fire the `execution.disputed` webhook; legacy reports get
  `verdict: UNATTESTED`.
- `proxy/executor.js`: fail closed if `sha256(payloadContent) !==
  execOrder.payload_hash`; compute request and response digests; send
  `Authorization: Bearer <gex_>`; sign the attestation with the server key
  (`kid: gate-exec`) until executor keys land in M1.
- `routes/audit.js`: `GET /v1/audit/:id/bundle` returning the §6 bundle
  with `bundle_hash` and signature.
- `index.js`: add `a2h_layer3` to `buildCapabilities`.
- `test/a2h-layer3.test.js` (same harness as `a2h-layer2.test.js`):
  propose → approve → execute → report with matching attestation gives
  `MATCH`; altered `request_digest` gives `MISMATCH` and `disputed`; second
  report after terminal is 409; report with API key and no attestation is
  `UNATTESTED`; bundle verifies and fails after any field is edited;
  file-path payload now carries a hash.

**M1 — real keys.** Executor registration (`agents.role = 'executor'` with a
JWK); verify ATTEST via `verifyDetachedJws`; give Gate an ES256 key and
`/.well-known/jwks.json`; sign grants, verdicts and bundles with it; hash
`execution_token` at rest.

**M2 — close the loop with the human.** `sendResult` in the a2h provider
(RESULT with `params.proof`); `DISPUTED`/`UNKNOWN` states end to end; hash
chain over `audit_events`.

**M3 — destination receipts.** `idempotency_key` in the request digest,
`receipt` capture per Profile, Run Ledger `sideEffectKey` keyed on
`request_digest` instead of `executionId`.

## 11. Open questions for the A2H community

1. Do EXECUTE and ATTEST belong in A2H (which is agent↔human), or should
   A2H standardize only RESULT `proof` and the audit bundle, leaving the
   enforcer↔executor messages to a companion spec?
2. Canonical request forms for non-HTTP actions (MCP tool calls, SQL,
   file writes): per-Profile, or a generic `{ destination, action,
   payload_hash }` triple as proposed here?
3. Executor identity: reuse `agent_id` DIDs with `did:web` JWKS, or a
   dedicated executor registry at the enforcer?
4. Should the gateway countersign the bundle so that neither enforcer nor
   gateway alone can fabricate a complete record?
5. What is the minimum meaningful proof on a low-bandwidth channel: a
   short bundle hash, a receipt id, or a link only?
6. Should `receipt` align with `links.acp_ref` / `ap2_mandate`, so an AP2
   mandate's fulfilment is the receipt of an A2H execution?
7. Verdict semantics when the destination reports a non-2xx that
   nevertheless means "already applied" (409 on an idempotent retry).
