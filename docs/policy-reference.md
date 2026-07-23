# Policy reference

Policies are YAML files in the server's `--policy-dir` (default
`./policies`). The file name is the policy ID: `support-reply.yaml` is
policy `support-reply`, and an intent selects it with
`policy: "support-reply"`.

Evaluation is deterministic — no LLM in the path. Same intent + same
policy file = same decision, every time. Policy files are hot-reloaded:
editing a `.yaml` file invalidates the server's cache for that policy
without a restart.

A missing policy fails closed: proposing against a policy ID with no file
returns `blocked`.

## Evaluation order

The engine (`packages/gate-server/src/lib/policy.js`) applies rules in
this exact order. The first rule that produces a decision wins.

| # | Rule | Field(s) | Decision on hit |
|---|---|---|---|
| 1 | Destination allowlist | `destinations` | `blocked` if the intent's destination isn't listed |
| 2 | Payload type allowlist | `allowed_types` | `blocked` if the payload's file extension isn't listed |
| 3 | Environment overrides | `environments` | no decision — overlays threshold fields for the intent's `metadata.environment` |
| 4 | Rate limits | `rate_limits` | `blocked` when the agent's hourly/daily proposal count is exceeded (fails closed on evaluation errors) |
| 5 | Field checks | `field_checks` | `blocked` on missing required fields, min/max violations, length, or regex mismatch (JSON payloads only) |
| 6 | Blocked terms | `block_if_terms` | `blocked` if any term appears in the payload after normalization |
| 7 | Always require approval | `require_approval: always` | `pending_approval` |
| 8 | Record-count thresholds | `require_approval_over`, `auto_approve_under` | `pending_approval` above the threshold; `approved` at or under the auto-approve line |
| 9 | Org-wide scope | `require_approval_for: org_wide` | `pending_approval` when `metadata.scope` is `org_wide` |
| — | Default | | `pending_approval` ("Awaiting review") — the fail-safe when nothing else decided |

Term matching (rule 6) normalizes both the payload and the policy terms:
lowercase, punctuation stripped, whitespace collapsed, and common leet
substitutions undone (`0→o`, `1→i`, `3→e`, `4→a`, `5→s`), so
`"r3fund-guaranteed"` still matches a `refund guaranteed` block term.

## Fields

### Core

```yaml
id: support-reply                    # must match the file name
destinations: [zendesk.reply]        # allowlist; omit to allow any destination
allowed_types: [csv, json]           # payload file-extension allowlist
block_if_terms:                      # normalized substring match
  - "refund guaranteed"
require_approval: always             # force human review for every intent
auto_approve_under: 100              # recordCount <= N → approved
require_approval_over: 100           # recordCount > N → pending_approval
require_approval_for: org_wide       # pending when metadata.scope == "org_wide"
expiry_minutes: 30                   # how long a pending intent waits before expiring
```

### Field checks

Validate JSON payload fields by dot-notation path:

```yaml
field_checks:
  - path: refund.amount
    required: true
    max: 500
  - path: customer.email
    pattern: "^[^@]+@[^@]+$"
  - path: note
    max_length: 2000
```

Supported per check: `required`, `min`/`max` (numbers), `max_length`
(strings/arrays), `pattern` (regex). Non-JSON payloads skip field checks.

### Rate limits

```yaml
rate_limits:
  per_agent_per_hour: 50
  per_agent_per_day: 200
```

Counted per proposing agent from the proposals ledger. Evaluation errors
block rather than pass.

### Environment overrides

Overlay any threshold fields per `metadata.environment`:

```yaml
auto_approve_under: 10
environments:
  production:
    auto_approve_under: 1
    require_approval: always
  staging:
    auto_approve_under: 1000
```

### Approval routing & authority (Layer 2)

These fields shape what happens *after* a `pending_approval` decision:

```yaml
require_approvals: 3          # N-of-M quorum: N distinct approvers needed
on_no_response: defer         # let a late decision land instead of hard-expiring
require_profile: email.send.v1  # intent must carry a matching typed action profile
approval_channel:             # route the approval request to a provider
  provider: kaicalls          # e.g. voice/SMS approval via KaiCalls
  kaicalls:
    to: "+15550001234"
    from_agent_id: "agt_..."
    voice_call: true
```

See the annotated demo policies in [`policies/`](../policies/) —
`finance-quorum-demo.yaml`, `defer-on-timeout-demo.yaml`,
`email-send-typed-profile-demo.yaml`,
`finance-high-risk-kaicalls-demo.yaml`, and the risk-tiered assurance
demos — for working examples of each.

## Capability discovery

`GET /.well-known/gate` reports which policy features and approval
providers the running deployment actually uses, derived from the policies
on disk rather than a hardcoded list.
