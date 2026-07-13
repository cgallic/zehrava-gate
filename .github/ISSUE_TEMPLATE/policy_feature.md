---
name: Policy field proposal
about: Propose a new YAML field for the policy engine
title: 'Policy field: '
labels: policy-engine
assignees: ''
---

## Field name

<!-- e.g. `require_approval_between_hours`, `max_payload_bytes` -->

## Semantics

<!-- What the field means and how it should be evaluated. Remember the
engine is deterministic (no LLM, no network at eval time) and fail-closed:
say explicitly whether a violation should produce `blocked` or
`pending_approval`, and where it fits in the evaluation order
(blocking checks run before approval checks — see
packages/gate-server/src/lib/policy.js). -->

## Example policy

```yaml
id: my-policy
destinations: [example.destination]
# your proposed field here
```

## Sample intent and expected decision

<!-- A concrete intent payload and the decision the field should produce
for it — this becomes the first test case. -->

Intent:

```json

```

Expected result: <!-- e.g. `blocked` with reason "..." / `pending_approval` / `approved` -->
