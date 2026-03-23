# Run Ledger Implementation Note

**Version:** 1.0  
**Date:** 2026-03-22  
**Status:** Internal feature — no public protocol yet

---

## Overview

Run Ledger adds execution continuity to Zehrava Gate. When an agent run breaks (crash, interruption, approval wait), it can resume from the last valid checkpoint without replaying side effects or losing progress.

**This is not:**
- A new workflow engine
- A memory system
- A transcript replay mechanism
- A dashboard (CLI-first for v1)

**This is:**
- A boring, reliable execution ledger
- Checkpointing at safe boundaries
- Resume from sealed checkpoints
- Side-effect deduplication on resume
- Inspectability via CLI and API

---

## Schema

### `run_ledgers`

The parent record for an agent run.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Internal ledger ID (`ledger_*`) |
| `run_id` | TEXT UNIQUE | External run ID (`run_*`) |
| `parent_run_id` | TEXT NULL | For nested/delegated runs |
| `runtime` | TEXT | Runtime identifier (e.g. 'zehrava-gate') |
| `agent_id` | TEXT | Agent performing this run (FK to agents) |
| `intent_summary` | TEXT | Human-readable summary |
| `status` | TEXT | active \| blocked \| completed \| failed \| manual_review_required |
| `current_step` | TEXT NULL | Current execution step |
| `last_safe_event_id` | TEXT NULL | Last event deemed safe for resume |
| `replay_boundary_event_id` | TEXT NULL | Events after this are included in resume |
| `permissions_json` | TEXT | JSON of allowed capabilities |
| `blocked_capabilities_json` | TEXT NULL | JSON array of blocked capabilities |
| `integrity_hash` | TEXT | Hash of (runId + agentId + intentSummary + schemaVersion) |
| `schema_version` | INTEGER | Ledger format version (currently 1) |
| `created_at` | INTEGER | Unix timestamp ms |
| `updated_at` | INTEGER | Unix timestamp ms |

### `run_events`

Ordered log of meaningful events in a run.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Event ID (`evt_*`) |
| `ledger_id` | TEXT | Parent ledger (FK) |
| `seq` | INTEGER | Sequence number (unique per ledger) |
| `event_type` | TEXT | Event type (see Event Model) |
| `event_ts` | INTEGER | Unix timestamp ms |
| `actor_id` | TEXT NULL | Who performed this action |
| `step_name` | TEXT NULL | Step name if part of a plan |
| `payload_json` | TEXT | JSON payload |
| `input_hash` | TEXT NULL | Hash of input data |
| `output_hash` | TEXT NULL | Hash of output data |
| `side_effect_class` | TEXT | none \| read \| write \| external_mutation \| payment \| notification \| delegation |
| `side_effect_key` | TEXT NULL | Deduplication key for this side effect |
| `status` | TEXT | recorded \| replayed \| skipped |
| `created_at` | INTEGER | Unix timestamp ms |

**Unique constraint:** `(ledger_id, seq)`

### `run_artifacts`

Files, outputs, or resources created during a run.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Artifact ID (`art_*`) |
| `ledger_id` | TEXT | Parent ledger (FK) |
| `event_id` | TEXT NULL | Event that created this (FK to run_events) |
| `artifact_type` | TEXT | csv \| json \| pdf \| model \| etc. |
| `uri_or_path` | TEXT | File path or URI |
| `content_hash` | TEXT NULL | SHA-256 of content |
| `metadata_json` | TEXT | JSON metadata |
| `created_at` | INTEGER | Unix timestamp ms |

### `run_checkpoints`

Sealed resumable state snapshots.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Checkpoint ID (`ckpt_*`) |
| `ledger_id` | TEXT | Parent ledger (FK) |
| `event_id` | TEXT | Event where checkpoint was taken (FK) |
| `checkpoint_reason` | TEXT | interruption \| failure \| approval_requested \| explicit_handoff \| periodic_safety \| risky_boundary |
| `resume_packet_json` | TEXT | Full resume context (see Resume Model) |
| `sealed_hash` | TEXT | Hash of (checkpointId + ledgerId + eventId + resumePacket + events) |
| `is_resumable` | INTEGER | 1 if valid, 0 if incomplete |
| `created_at` | INTEGER | Unix timestamp ms |

### `run_handoffs`

Records when work is handed off between agents or to humans.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Handoff ID (`ho_*`) |
| `ledger_id` | TEXT | Parent ledger (FK) |
| `checkpoint_id` | TEXT | Checkpoint at handoff point (FK) |
| `from_actor` | TEXT | Who initiated handoff |
| `to_actor` | TEXT | Who receives handoff |
| `handoff_type` | TEXT | approval \| delegation \| manual |
| `handoff_summary` | TEXT NULL | Human-readable description |
| `status` | TEXT | pending \| completed |
| `created_at` | INTEGER | Unix timestamp ms |

---

## Event Model

### Event Types

| Event | Meaning | Counts as Progress |
|-------|---------|-------------------|
| `run_started` | Run begins | No |
| `plan_locked` | Execution plan finalized | ✅ Yes |
| `tool_call_started` | Tool invocation begins | No |
| `tool_call_finished` | Tool invocation completes | ✅ Yes |
| `artifact_created` | File/output created | ✅ Yes |
| `intent_proposed` | Gate intent submitted | No |
| `policy_checked` | Policy evaluation complete | ✅ Yes |
| `approval_requested` | Human approval needed | No |
| `approval_received` | Human approved | ✅ Yes |
| `execution_requested` | Execution order issued | No |
| `execution_succeeded` | Execution completed | ✅ Yes |
| `delegation_started` | Work delegated to sub-agent | No |
| `delegation_finished` | Sub-agent completed | ✅ Yes |
| `checkpoint_sealed` | Checkpoint created | No |
| `interruption_detected` | Run interrupted | No |
| `run_resumed` | Run resumed from checkpoint | No |
| `run_completed` | Run finished successfully | ✅ Yes |
| `run_failed` | Run hard failed | No |

### Side Effect Classes

Determines whether an event can be safely replayed on resume.

| Class | Replayable | Examples |
|-------|------------|----------|
| `none` | ✅ Yes | Pure computation, logging |
| `read` | ✅ Yes | Database reads, API GETs |
| `write` | ⚠️ Maybe | Local file writes (idempotent) |
| `external_mutation` | ❌ No | Database writes, API POSTs |
| `payment` | ❌ No | Stripe charges, refunds |
| `notification` | ❌ No | Emails, SMS, webhooks |
| `delegation` | ⚠️ Maybe | Sub-agent spawns (if idempotent) |

### Side Effect Deduplication

For any event with `side_effect_class` in `[external_mutation, payment, notification]`:

1. Compute `side_effect_key` = `hash({ action, target, payloadHash })`
2. Before re-executing on resume: check `SELECT id FROM run_events WHERE ledger_id = ? AND side_effect_key = ? AND status = 'recorded'`
3. If found → skip, mark as `status = 'skipped'`
4. If not found → execute, mark as `status = 'recorded'`

This prevents double-sends, double-charges, and duplicate database writes after resume.

---

## Integrity Model

### Ledger Integrity Hash

Computed once at run creation:

```
integrity_hash = SHA-256({
  runId,
  agentId,
  intentSummary,
  schemaVersion
})
```

Stored in `run_ledgers.integrity_hash`. Verifies run identity.

### Checkpoint Sealed Hash

Computed at checkpoint creation:

```
sealed_hash = SHA-256({
  checkpointId,
  ledgerId,
  eventId,
  canonicalize(resumePacket),
  eventHashes: events.map(e => SHA-256({ e.id, e.seq, e.type, e.payload }))
})
```

Stored in `run_checkpoints.sealed_hash`. Verifies checkpoint has not been tampered with.

### Canonical Serialization

Before hashing any object:
1. Sort keys recursively
2. Remove `undefined` values
3. Serialize to JSON

This ensures stable hashes across key-order differences.

---

## Resume Model

### Resume Packet

A checkpoint's `resume_packet_json` contains everything needed to continue:

```json
{
  "runId": "run_abc123",
  "ledgerId": "ledger_xyz789",
  "checkpointEventId": "evt_...",
  "originatingRuntime": "zehrava-gate",
  "originatingAgent": "lead-enrichment-agent",
  "intentSummary": "Enrich leads and sync to Salesforce",
  "currentStep": "review",
  "lastSafeEventId": "evt_...",
  "replayBoundaryEventId": "evt_...",
  "replayBoundarySeq": 5,
  "receipts": [
    { "eventId": "evt_...", "seq": 6, "type": "tool_call_finished", ... }
  ],
  "artifacts": [
    { "artifactId": "art_...", "type": "csv", "uri": "./leads.csv", "hash": "..." }
  ],
  "unresolvedApprovals": [
    { "eventId": "evt_...", "payload": { "intentId": "int_..." } }
  ],
  "remainingPermissions": { "allowed_tools": ["..."] },
  "blockedCapabilities": ["unsafe_writes"],
  "nonReplayableSideEffects": [
    { "key": "abc123...", "type": "execution_succeeded", "eventId": "evt_..." }
  ],
  "suggestedNextAction": "await_approval_then_execute",
  "schemaVersion": 1
}
```

### Resume Flow

1. Load latest resumable checkpoint
2. Verify `sealed_hash` integrity
3. Parse `resume_packet_json`
4. Build resume context:
   - Receipts (what happened)
   - Artifacts (what was created)
   - Unresolved approvals (what's blocked)
   - Remaining permissions (what's allowed)
   - Blocked side effect keys (what must not repeat)
5. Emit `run_resumed` event
6. Update run status to `active`
7. Continue execution from `currentStep` or `suggestedNextAction`

### Resume Context

Returned by `ResumeResolver.resume()`:

```js
{
  runId,
  ledgerId,
  checkpointId,
  runtime,
  agentId,
  intentSummary,
  currentStep,
  receipts,             // What happened before
  artifacts,            // What was created
  unresolvedApprovals,  // What needs attention
  remainingPermissions, // What's still allowed
  blockedCapabilities,  // What's forbidden
  nonReplayableSideEffects,  // Full list
  blockedSideEffectKeys,     // Set of keys (for fast lookup)
  suggestedNextAction,
  resumedAt,
  schemaVersion
}
```

---

## Known Limitations (v1)

1. **No cross-runtime portability**  
   Resume packets are Zehrava-specific. No protocol/spec for other runtimes.

2. **No distributed consensus**  
   Checkpoints are local SQLite. Multi-node deployments need external coordination.

3. **Manual review fallback only**  
   If checkpoint verification fails, run is marked `manual_review_required`. No auto-repair.

4. **No automated pruning**  
   Old runs/events/checkpoints accumulate. Operator must clean up manually.

5. **No transactional writes**  
   Events are recorded individually. Interruption mid-checkpoint could leave partial state.

6. **No UI (v1)**  
   Dashboard not built. CLI-only inspect/resume.

7. **No policy-driven checkpointing**  
   Checkpoint triggers are manual or event-based. No "checkpoint every N progress events" policy.

8. **No lineage verification**  
   `parent_run_id` chain is stored but not verified in `verify` endpoint.

---

## CLI Commands

```bash
# Inspect run
zehrava-gate runs inspect <run_id>

# List events
zehrava-gate runs events <run_id>

# Create checkpoint
zehrava-gate runs checkpoint <run_id>

# Resume from checkpoint
zehrava-gate runs resume <run_id>

# Verify integrity
zehrava-gate runs verify <run_id>
```

---

## API Endpoints

All under `/internal/runs` (not publicly documented yet):

- `POST /internal/runs/start` — Start a run
- `POST /internal/runs/:runId/events` — Record event
- `POST /internal/runs/:runId/checkpoint` — Create checkpoint
- `POST /internal/runs/:runId/resume` — Resume from checkpoint
- `GET /internal/runs/:runId` — Get run details
- `GET /internal/runs/:runId/events` — List all events
- `POST /internal/runs/:runId/verify` — Verify integrity

---

## SDK Usage

```js
const { Gate } = require('zehrava-gate');
const gate = new Gate({ endpoint: '...', apiKey: '...' });

// Start run
const run = await gate.startRun({
  agentId: 'my-agent',
  intentSummary: 'Do the thing',
  permissions: { allowed_tools: ['fetch', 'transform'] }
});

// Record progress
await gate.recordEvent({
  runId: run.runId,
  eventType: 'tool_call_finished',
  payload: { tool: 'fetch', rows: 100 }
});

// Checkpoint
await gate.createCheckpoint({
  runId: run.runId,
  reason: 'approval_requested'
});

// Resume later
const ctx = await gate.resumeRun({ runId: run.runId });
console.log(ctx.receipts);
```

---

## Integration Points

To hook Run Ledger into actual execution:

1. **On run start** → `RunLedger.start()` → emit `run_started`
2. **On plan finalized** → emit `plan_locked`
3. **Before tool call** → emit `tool_call_started`
4. **After tool call** → emit `tool_call_finished` (with side effect class/key)
5. **On artifact created** → `RunLedger.createArtifact()` + emit `artifact_created`
6. **On Gate propose** → emit `intent_proposed`
7. **On policy evaluated** → emit `policy_checked`
8. **On approval needed** → emit `approval_requested`
9. **On approval received** → emit `approval_received`
10. **On execution requested** → emit `execution_requested`
11. **On execution succeeded** → emit `execution_succeeded` (with side effect key!)
12. **On delegation** → emit `delegation_started` / `delegation_finished`
13. **On interruption** → emit `interruption_detected` + checkpoint
14. **On completion** → emit `run_completed` + update status

**Do not instrument conversational chatter.**

---

## What's Next (v2+)

- Dashboard UI (run list, event timeline, checkpoint browser)
- Periodic auto-checkpointing policy
- Run pruning / archival
- Transactional event batching
- Lineage verification
- Cross-runtime protocol/spec
- Resume from arbitrary event (not just checkpoints)
- Distributed checkpoint storage (S3, etc.)

---

**Run Ledger is done when interrupted runs don't start over.**
