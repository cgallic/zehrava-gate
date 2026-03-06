# Agent Sentinel — Canonical PRD
**Silent agent failures, caught in real time.**
*Version 1.0 | March 2026*

---

## One-line definition

Agent Sentinel detects silent failures in production agent stacks — OpenClaw sessions, tool calls, cron scripts, API calls — fires an alert with full context in under 10 seconds, and lets you replay exactly what happened so you can take over or fix it.

---

## Why this exists

AI agents fail silently. They time out. They loop. They call a tool that returns an error and keep going anyway. They stop producing output and nobody notices until a client calls or a lead is missed.

Current response: check logs manually, wait for someone to complain, find out at month-end when churn hits.

There is no standard way to detect, alert on, and recover from agent failures in real time. Agent Sentinel is that layer.

---

## Problem

### What happens today

* agent gets stuck in a loop → user waits indefinitely
* cron script fails silently → no output for 24 hours, nobody knows
* tool call returns an error → agent halts with no alert
* heartbeat check misses → lead is not processed
* API call times out → downstream task never completes
* context window fills → agent truncates and behaves strangely

### Why existing tools don't solve it

* **LangSmith / Langfuse / Helicone** — observability and tracing. You look at them after something broke. No real-time alerting, no escalation, no auto-retry.
* **Datadog / Sentry** — infra and code monitoring. Not agent-aware. Cannot detect loops, hallucinations, or drift.
* **PagerDuty** — alerts for infra. Does not know what an agent run is.
* **Manual log review** — does not scale, not real-time, requires engineering attention.

The gap: real-time detection + escalation + run replay specifically for agent failures. Nobody owns this.

---

## Solution

Agent Sentinel wraps or instruments your existing agent runs. When a failure is detected, the right person is notified immediately with full context — what the agent was doing, what broke, what the impact is, and what to do next.

**Core loop:**

```
Agent runs → Sentinel monitors → Failure detected → Alert fires → Human responds → Resolution logged
```

---

## Target users

### Primary: operators running OpenClaw or custom agent stacks

Examples of what they run:
* OpenClaw heartbeat sessions
* KaiCalls lead outreach scripts
* ABP lead webhook handlers
* Cron-based analytics pipelines
* Multi-agent MDI workflows

Pain: silent failures cost them money, missed leads, broken automations they don't notice for hours.

### Secondary: AI automation agencies

Running 10–50 client-deployed agents. Client-facing accountability. One silent failure becomes a client complaint.

### Tertiary: SaaS teams with embedded AI

Customer-facing agent features. Responsible for uptime. Need audit trail.

---

## Failure taxonomy

| Failure type | Description | Severity |
|---|---|---|
| Timeout | Agent exceeds max response time | High |
| Loop | Agent repeating same action 3+ times | High |
| Hallucination | Response contradicts known facts or safety rules | Critical |
| No-action | Agent received input, produced no output | Medium |
| Tool failure | External API call failed, agent did not recover | High |
| Drift | Agent behavior statistically differs from baseline | Medium |
| Context overflow | Token limit hit, agent truncated context | Medium |
| Auth failure | Agent failed to authenticate to a required service | High |
| Cron miss | Scheduled job did not run within expected window | High |

---

## Core features (v1)

### 1. Sentinel SDK

Wrap any agent run in under 5 lines:

```typescript
import { Sentinel } from '@agentsentinel/sdk';

const sentinel = new Sentinel({ apiKey: process.env.SENTINEL_KEY });

const result = await sentinel.monitor('agent-name', async () => {
  return await myAgent.run(input);
}, {
  maxDuration: 30000,
  outcomeCheck: (r) => r.success,
  tags: { client: 'acme-corp', type: 'lead-qualification' }
});
```

Zero dependencies. Under 5KB. Works with any agent framework.

### 2. Heartbeat monitor

For cron jobs and recurring pipelines:

```typescript
// Register a heartbeat — if it doesn't ping every N minutes, alert fires
sentinel.heartbeat('abp-lead-processor', { intervalMinutes: 35 });

// In the cron job:
await sentinel.ping('abp-lead-processor');
```

Detects: cron didn't run, cron ran but took too long, cron ran but didn't produce expected output.

### 3. Alert routing

* Slack (primary — webhook or bot)
* Discord (channel or DM)
* SMS via Twilio
* Email
* Webhook (custom)

Alert payload:
* Agent name + run ID
* Failure type + severity
* Client or tag context
* Full step timeline
* Suggested remediation
* Link to run replay

### 4. Run replay

Timeline of every step in a failed run:
* Input received
* Tool calls made (with parameters and response)
* Intermediate outputs
* Failure point highlighted
* Token usage per step

### 5. Escalation workflow

1. Alert fires → assigned responder notified
2. Responder acknowledges (timer starts)
3. Human takes over conversation or marks recovered
4. Resolution reason logged
5. Optional: auto-retry after fix

### 6. Dashboard

* Active incidents (real-time)
* Agent health grid (green / yellow / red per agent)
* Incident history and resolution times
* MTTR per agent
* Alert fatigue metrics (false positive rate)

---

## Dogfood stack (week 1 testbed)

These are real agent flows already running on the stack. Instrument these first:

| Flow | Agent | Failure modes to detect |
|---|---|---|
| Kai-CMO heartbeat | OpenClaw session | Cron miss, no output, timeout |
| ABP lead webhook | Custom script | Webhook not triggered, processing error |
| KaiCalls outreach | kaicalls_lead_outreach.py | Script crash, no leads processed |
| Daily/weekly report | cron_daily.sh | Cron miss, report not generated |
| SnappedAI uptime | MDI session | Session drop, no response |
| ABP outbound call trigger | kaicalls.ts | API failure, no call queued |

Each of these running through Sentinel before any external customer. Real failures, real alerts, real case study.

---

## Customer journeys

### Journey 1: Operator — "The cron that stopped running"

**Before Sentinel:**
ABP lead webhook processing script dies silently. 12 leads sit unprocessed over a weekend. Noticed Monday when no vendor emails went out.

**With Sentinel:**
Script registered as a heartbeat. Expected to ping every 30 minutes. At 11pm Friday, no ping. Alert fires to Slack: "ABP lead processor — no ping in 35 minutes. Last successful run: 10:47pm. 4 leads may be unprocessed. [View replay]"

Total missed time: 35 minutes. Zero leads lost.

---

### Journey 2: Agency — "The client complaint"

**Before Sentinel:**
Client's lead qualification agent starts looping on ambiguous inputs at 8pm Friday. 47 leads unqualified over the weekend. Monday morning: client calls angry.

**With Sentinel:**
Loop detected at 8:03pm. Slack alert: "TechCorp Lead Agent: Loop detected. 3 identical tool calls in 90 seconds. 4 leads affected. [View replay]" Fixed in 12 minutes. Client never knows.

---

### Journey 3: SaaS — "The silent hallucination"

**Before Sentinel:**
Support agent starts including incorrect pricing. 12 customers get wrong quotes. Discovered 2 days later via support ticket spike. $30K in refunds.

**With Sentinel:**
Safety rule: response must not include dollar amounts without querying pricing API. First violation → alert fires. Agent auto-paused (circuit breaker). 1 customer affected instead of 12.

---

## Technical architecture

```
Agent code (customer stack)
  ↓
Sentinel SDK (lightweight wrapper / heartbeat ping)
  ↓
Sentinel API (hosted)
  ├── Real-time event stream
  ├── Failure detection engine (deterministic, no LLM calls)
  ├── Baseline comparison (drift detection)
  └── Alert router
       ├── Slack
       ├── Discord
       ├── SMS (Twilio)
       └── Webhook
  ↓
Dashboard (React, real-time via WebSocket)
  ↓
Data store (Postgres + TimescaleDB for time-series events)
```

Key design decisions:
* No LLM calls in the monitoring path — detection is deterministic
* SDK is under 5KB, zero dependencies
* All agent data encrypted at rest
* WebSocket for real-time dashboard
* Self-host option for enterprise (data stays in their infra)

---

## Pricing

| Tier | Price | Limits |
|---|---|---|
| Starter | $99/mo | 5 agents, 1,000 monitored runs/mo |
| Growth | $399/mo | 25 agents, 10,000 runs/mo |
| Scale | $999/mo | 100 agents, unlimited runs |
| Enterprise | Custom | Self-host + SSO + SLA + compliance exports |

Add-ons:
* Client-ready incident report (PDF): $49/mo
* Agent File Bus integration: included in Scale+

---

## Build order (week 1)

**Day 1–2:** Event schema + ingest endpoint. Store agent runs with correlation IDs.

**Day 3:** Failure detectors — timeout, loop (repeated step pattern), no-response, tool error threshold, cron miss.

**Day 4:** Incident engine — dedupe and group related failures, incident lifecycle (open / ack / resolved), attach replay context.

**Day 5:** Alert routing — Slack webhook first, Discord mirror, payload with agent name + severity + summary + replay link.

**Day 6:** Heartbeat monitor — register named heartbeats, detect missed pings, alert on miss.

**Day 7:** Minimal dashboard + dogfood wiring. Instrument the 6 real flows listed above. Run end-to-end: force a cron miss → alert fires in under 10 seconds.

---

## Milestones

**Week 1:** SDK + heartbeat + Slack alerts working. 6 internal flows instrumented.
**Week 2:** Run replay + dashboard alpha. 3 external design partners onboarded.
**Week 3:** Baseline detection + drift alerts. First $99 charges.
**Week 4:** Self-serve onboarding. 10 customers. Case study published (ABP leads recovered, X minutes MTTR).

**Month 2:** Escalation workflows, client-facing incident reports. 30 customers.
**Month 3:** Agent File Bus integration, CFO overlay (cost per agent). ARR path visible.

---

## Risks

| Risk | Mitigation |
|---|---|
| LangSmith ships real-time alerts | Go deeper: auto-retry, client reports, heartbeats — not just traces |
| False positives erode trust | Baseline calibration during onboarding + false positive feedback loop |
| Enterprise security concerns | SOC2 roadmap, self-host option from architecture day 1 |
| SDK adoption friction | Under 5 lines to integrate, no dependencies, works with any framework |

---

## Repo

`github.com/cgallic/agent-sentinel`

Both agents (Kai-CMO on 89.167.60.171, SnappedAI on 77.42.43.0) push specs and code here.
Shared GitHub token or per-agent deploy key. moonbags merges.

---

*Canonical v1.0 | March 2026*
*Next: API spec, DB schema, 30-day ticket board*
