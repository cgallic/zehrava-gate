# Contributing to Zehrava Gate

Thanks for helping build the write-path control plane for AI agents. This
guide covers running the server, running the tests, and the two areas where
contributions are most wanted: **approval providers** and **policy engine
fields**.

## Getting started

```bash
git clone https://github.com/cgallic/zehrava-gate
cd zehrava-gate/packages/gate-server
npm install
npm start
```

Or run the published package directly:

```bash
npx zehrava-gate --port 4000 --policy-dir ./policies
```

The server is plain Node.js (Express + SQLite via `better-sqlite3`). There is
no build step, no transpiler, no bundler — `npm start` runs
`node src/index.js` directly.

Useful flags/env:

- `--port <n>` — HTTP port (default 4000)
- `--data-dir <path>` — SQLite + payload storage (default `./data`)
- `--policy-dir <path>` — YAML policy directory (default `./policies`);
  also settable via the `POLICY_DIR` env var. Policies are cached and
  hot-reloaded when a `.yaml` file changes on disk.
- `npx zehrava-gate demo` — self-contained demo, no config needed

## Running tests

```bash
cd packages/gate-server
npm test
```

The suite is 11 test files in `packages/gate-server/test/`. They are **plain
Node scripts — no test framework**. Each file defines a local
`assert(condition, msg)` helper, prints `✓`/`✗` per assertion, and exits
non-zero on failure. `npm test` just runs the files in sequence with `node`.

You can run a single file directly:

```bash
node test/action-profiles.test.js
```

New tests should follow the same pattern: a standalone
`test/<feature>.test.js` script, added to the `test` script in
`packages/gate-server/package.json`.

## Repo layout

```
packages/
  gate-server/      Server + JS SDK + CLI (npm: zehrava-gate)
    src/index.js      Server entry point
    src/sdk.js        JS SDK entry point
    src/routes/       API routes (proposals, approvals, executions, authority, runs, ...)
    src/lib/          Policy engine, DB, approval providers, action profiles
    test/             The 11-file test suite
  gate-sdk-js/      Standalone JS SDK package
  gate-sdk-py/      Python SDK (PyPI: zehrava-gate)
  langchain-gate/   LangChain/LangGraph tool wrapper (npm: zehrava-gate-langchain)
  mcp-gate/         Gate MCP server
policies/           Example + demo policy YAML files
schemas/            JSON Schemas (intent, agent, execution-order, policy-decision, audit-event)
examples/           End-to-end examples (hubspot-gate, zendesk-gate, finance-gate, run-resume)
```

## Most-wanted contribution 1: approval providers

When policy decides an intent is `pending_approval`, Gate can dispatch the
approval request to a human over an external channel (voice call, SMS, and —
we'd love your PR — Slack, email, Teams, ...). That dispatch is handled by an
**approval provider**.

Providers live in `packages/gate-server/src/lib/approval-providers/`. Current
ones: `dashboard`, `kaicalls` (SMS + voice), `a2h` (signed agent-to-human
bridge), and `noop` (for tests).

### The provider interface

A provider is a module exporting an object with four async methods:

```js
module.exports = {
  name: 'myprovider',

  // Deliver the approval request over your channel. `approvalRequest`
  // includes the policy object (your channel config lives at
  // approvalRequest.policy.approval_channel.myprovider), a single-use
  // approvalUrl pointing at Gate's own approve/reject page, and a
  // messageId. Return { interactionId, messageId, state: 'sent', ... }.
  async sendAuthorize(intent, approvalRequest) {},

  // Best-effort delivery status. Informational only — Gate's own
  // approval_state is always the authoritative record.
  async getStatus(interactionId) {},

  // Cancel/recall the outbound request if your channel supports it.
  // Never blocks Gate's own cancel flow.
  async cancel(interactionId) {},

  // Verify a signed inbound decision callback. Most providers are
  // notification-only and return { valid: true } unconditionally, because
  // the human decides via Gate's own single-use approval link. Only return
  // meaningful verification here if your channel produces a
  // cryptographically signed decision (see a2h.js for the model).
  async verifyResponse(response, originalMessageId) {},
};
```

**Design rule:** a provider is a *notification channel, not a decision
authority*. Gate captures the decision itself via its approve/reject and
approval-link endpoints. A provider only becomes part of the decision path if
its `verifyResponse()` actually cryptographically proves a signed response
(as the A2H bridge does). Read the comments at the top of
`approval-providers/index.js` and `kaicalls.js` before writing one.

### Adding a provider

1. Create `src/lib/approval-providers/slack.js` (say) implementing the four
   methods. `kaicalls.js` is the best template for a notification-only
   channel; `a2h.js` for a signed-response channel. Follow the kaicalls
   pattern of stubbing (log + return `{ stub: true }`) when credentials env
   vars are unset, so tests never hit the real service.
2. Register it in `src/lib/approval-providers/index.js`: add it to the
   `PROVIDERS` map and declare which approval factors it can produce
   evidence for in `DEFAULT_CAPABILITIES` (e.g. kaicalls declares
   `['voice.ivr.v1', 'voice.spoken.v1', 'sms.otp.v1']`). Capabilities are
   used by the risk-tiered assurance checks to reject configs that ask a
   provider for a factor it can't deliver. Operators can also override
   capabilities via the `GATE_PROVIDER_CAPABILITIES` env var (JSON).
3. Providers are selected per policy via YAML, with provider-specific config
   nested under the provider's name:

   ```yaml
   approval_channel:
     provider: slack
     slack:
       channel: "#approvals"
   ```

   (An intent may also pass `approval_channel` in the request body; the
   dispatch logic in `src/routes/proposals.js` resolves request → policy →
   `dashboard` default.)
4. Add a `test/slack-provider.test.js` following the existing plain-script
   pattern (see `test/kaicalls-provider.test.js` and
   `test/dispatch-provider.test.js`), and wire it into the `test` script in
   `package.json`. The E2E harness (`test/e2e-approval-provider.test.js`)
   shows how to exercise the full dispatch → callback loop.

## Most-wanted contribution 2: policy engine fields

The policy engine is a single file:
`packages/gate-server/src/lib/policy.js`. `evaluatePolicy(policyId, intent)`
returns `{ status: 'approved' | 'blocked' | 'pending_approval', reason? }`
and evaluates YAML fields **deterministically, in a fixed order** — blocks
first, then approval requirements, then auto-approve:

1. `destinations` — allowlist; unlisted destination → `blocked`
2. `allowed_types` — payload type/extension allowlist → `blocked`
3. `environments` — per-environment overrides merged in when
   `metadata.environment` matches (e.g. looser thresholds in `staging`)
4. `rate_limits` — `per_agent_per_hour` / `per_agent_per_day`, counted from
   SQLite; evaluation errors **fail closed** (blocked)
5. `field_checks` — JSON payload field rules (`path` with dot notation,
   `required`, `min`/`max` for numbers, `max_length`, `pattern` regex) →
   `blocked` on violation
6. `block_if_terms` — sensitive-term match on normalized payload text
   (lowercased, punctuation stripped, basic leet-speak like `r3fund`
   defeated) → `blocked`
7. `require_approval: always` → `pending_approval`
8. `require_approval_over` / `auto_approve_under` — record-count thresholds
9. `require_approval_for: org_wide` — with `metadata.scope: org_wide` →
   `pending_approval`
10. **Default: `pending_approval` ("Awaiting review")** — the engine is
    fail-closed; nothing is auto-approved unless a rule says so

### Adding a field

1. Implement the check in `evaluatePolicy()` in `src/lib/policy.js`. Place it
   deliberately in the order above (blocking checks before approval checks),
   keep it deterministic (no LLM calls, no network), and fail closed on
   errors.
2. Register the field in `getPolicyFeatures()` in the same file, so it shows
   up in capability discovery (`GET /.well-known/gate`).
3. Add an example policy exercising it under `policies/` (the
   `*-demo.yaml` files are the pattern).
4. Add tests — either a new `test/<field>.test.js` plain-script file wired
   into `npm test`, or assertions in the closest existing file. Cover at
   minimum: the field triggering, the field not triggering, and the
   malformed-input path (which should block, not approve).
5. Document the field in the policy examples section of the README if it's
   user-facing.

## Pull request expectations

- **Tests pass:** `npm test` in `packages/gate-server` must be green, and new
  behavior needs new assertions.
- **Small, focused diffs:** one feature or fix per PR. Split refactors from
  behavior changes.
- **Fail-closed:** anything ambiguous in the write path should block or go to
  `pending_approval`, never silently approve.
- Update `CHANGELOG.md` (Unreleased section) for user-facing changes.

## Code style

- Plain JavaScript (CommonJS `require`/`module.exports`), Node 18+. No
  TypeScript in the server, no build step, no linter config — match the
  style of the file you're editing.
- Keep dependencies minimal; the server deliberately has a tiny dependency
  footprint.
- Comments explain *why* (see the provider files for the tone) — security
  rationale especially.

## Security issues

Do **not** open public issues for vulnerabilities — see
[SECURITY.md](./SECURITY.md).
