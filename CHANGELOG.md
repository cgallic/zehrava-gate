# Changelog

All notable changes to Zehrava Gate are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: versions before 0.3.0 are reconstructed from commit history rather
> than tags, and the recorded git history begins 2026-03-08 — the initial
> 0.1.x implementation predates it.

## [Unreleased]

Approval protocol overhaul (July 2026):

### Added
- **KaiCalls approval channel** — dispatch pending approvals to a human via
  SMS + voice call, with a single-use approval link captured by Gate itself
  (#11)
- **Approval interaction ledger and principal/channel model** — every
  approval interaction is recorded against a principal and channel (#12, #4)
- **Configurable approval providers with signed-callback verification** —
  approvals dispatch through a pluggable provider layer
  (`src/lib/approval-providers/`); inbound provider callbacks are
  cryptographically verified (#13, #14). Dispatch payloads enriched and
  expired-interaction callbacks covered.
- **Signed outbound webhook deliveries with retry** (#6)
- **E2E approval-provider test harness**, including an opt-in
  real-provider smoke test (#16)
- **Risk-tiered approval assurance policy** — policies can require specific
  approval factors (e.g. voice, SMS OTP), and providers declare which
  factors they can evidence (#15)
- **A2H/Ola bridge provider** — signed agent-to-human approval responses
  from an external gateway (#7)
- **A2H v1.0 conformance for the Ola bridge** — the `a2h` provider now
  speaks the published Agent-to-Human spec (twilio-labs/Agent2Human) that
  Twilio Ola is built on: spec AUTHORIZE envelope to `POST /v1/intent`,
  `X-A2H-Signature` webhook RESPONSEs, detached-JWS verification against the
  gateway's JWKS (`jwks_uri`, `require_jws`), `/v1/status` polling fallback
  (resumed on restart), `/v1/cancel` propagation, and `ERROR`/expiry
  handling. Verified against the twilio-labs reference gateway with a real
  WebAuthn passkey. The pre-spec payload remains available as
  `wire_format: gate-legacy`. Runnable example in `examples/ola-a2h/`.
- **A2H Layer 2 proposal + reference implementation** —
  [`docs/a2h-layer2-proposal.md`](docs/a2h-layer2-proposal.md) drafts the
  authority & policy layer A2H v1.0 defers (POLICY, REVOKE, DELEGATE, SCOPE,
  multi-party, conditional defaults) and introduces the Enforcer role.
  `POST /v1/a2h/layer2` accepts POLICY / REVOKE / DELEGATE in that wire
  format and maps them onto standing approvals and delegations, failing
  closed (`ERR.UNSUPPORTED_CONDITION`) on any condition Gate can't enforce
  exactly. Advertised in `/.well-known/gate` and `/.well-known/a2h`.

### Changed
- A verified provider **decline** is now honoured even when it carries none
  of the policy's required approval factors. Required factors gate
  approvals only; previously a decline without them was rejected with
  `insufficient_evidence_factors` and the approval stayed open.
- **Typed action profiles** — schema-validated payloads for known action
  types (e.g. `email.send.v1`, `payment.refund.v1`) with profile-aware
  evidence and tamper binding (#10)
- **Layer 2 authority model** — standing approvals, delegation, N-of-M
  quorum, and timeout defaults (#8)
- **Gate MCP server** (`packages/mcp-gate`) — exposes approval primitives
  over MCP without letting an agent cross the execution-token boundary (#9)
- Roadmap document for making Gate the default control plane for agentic
  builders

### Fixed
- Approval protocol hardening: already-answered or expired approval
  interactions can no longer be answered again (#11)

## [0.3.0] - 2026-03-23

The Run Ledger release.

### Added
- **Run Ledger v1** — execution continuity for governed agent runs; an
  interrupted run can resume against its recorded intents (see
  `examples/interrupted_intent_run_resume.js`)
- **LangChain/LangGraph integration** (`zehrava-gate-langchain`) — `GateTool`
  wrapper that routes any tool call through Gate policy before executing
- **Gate V3 forward proxy (Phases 1–3)** — network-level enforcement on port
  4001: forward proxy, TLS intercept, `gate_exec` + credential vault
- **Schema-aware policies and proxy hold queue** — held requests auto-replay
  once approved
- `/for/` persona pages and V3 spec on the landing site

### Fixed
- Working `npx zehrava-gate demo` CLI, database schema migrations, and
  LangChain package publication
- Approvals and dashboard locked down on the public instance; public feed
  made demo-only and browser demo key removed

## [0.2.0] - 2026-03-08

Complete V2 rewrite of the SDK and intent lifecycle.

### Added
- **V2 SDK** — `propose / approve / reject / execute / verify /
  registerWebhook`, signed execution orders (`gex_` tokens), and the full
  documented status taxonomy (`approved`, `blocked`, `pending_approval`,
  `duplicate_blocked`, `execution_succeeded`, `execution_failed`)
- **Persistent webhooks** — webhook registrations now stored in SQLite
  instead of memory

### Changed
- Server audit event names aligned with the documented taxonomy
- Idempotency-key duplicates surface as `status: duplicate_blocked` rather
  than a bare HTTP 409

### Fixed
- Webhook `intentId` field, `approvedAt` field, and `/health` version
  reporting

## [0.1.x] - 2026-03 (predates recorded history)

### Added
- Initial Gate server: intent submission, deterministic YAML policy engine
  (destination allowlists, blocked terms, auto-approve/require-approval
  thresholds), human approval flow, audit trail, SQLite storage
- Agent registration and API keys
- JavaScript and Python SDKs
- Dashboard for reviewing and deciding pending intents
- Example policies and integration examples (HubSpot, Zendesk, finance)

[Unreleased]: https://github.com/cgallic/zehrava-gate/compare/v0.3.0...HEAD
