---
name: Bug report
about: Something in Gate behaved differently than documented
title: ''
labels: bug
assignees: ''
---

## Gate version

<!-- e.g. 0.3.0 — from `npm ls zehrava-gate`, or the commit SHA if running from source -->

## How are you running Gate?

- [ ] `npx zehrava-gate`
- [ ] Docker
- [ ] From source (`packages/gate-server`)

<!-- Include the flags/env you start it with, e.g. `--port 4000 --policy-dir ./policies` -->

## Policy YAML in play

<!-- The policy file(s) the intent was evaluated against. Redact anything sensitive. -->

```yaml

```

## Intent payload submitted

<!-- The propose() call or POST /v1/intents body. REDACT real customer data, API keys, phone numbers. -->

```json

```

## Expected decision/status

<!-- e.g. "expected status: pending_approval because record_count > require_approval_over" -->

## Actual decision/status

<!-- What Gate actually returned, including blockReason if any -->

## Relevant audit-trail output

<!-- Output of GET /v1/intents/:id/audit (and /decision if relevant), plus any server logs. Redact as needed. -->

```

```
