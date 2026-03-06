# Agent Sentinel — PRD
**"PagerDuty for AI Agents"**
*Version 0.1 | March 2026*

---

## 1. PROBLEM

AI agents are deployed to production. They fail silently.

- Agent gets stuck in a loop → customer waits indefinitely
- Agent hallucinates → sends wrong info to a client
- Agent times out → task never completes, nobody knows
- Agent drifts → behavior changes without a code change

Today's response: check logs manually, hear about it from an angry user, or find out at month-end when churn hits.

**Root cause:** There is no standard way to detect, alert, and escalate agent failures in real time.

---

## 2. SOLUTION

Agent Sentinel monitors every agent run in real time. When something goes wrong, the right human is notified immediately with full context — conversation history, failure type, severity, and recommended action.

**Core loop:**
`Agent fails → Sentinel detects → Alert fires → Human responds → Resolution logged`

---

## 3. PRODUCT GOALS

**Primary:** Eliminate silent agent failures for teams running 5+ production agents

**V1 goal:** 10 paying customers, 3 resolved incidents per week per customer, <5 min mean time to alert

**V2 goal:** Expand to CFO layer (cost/margin per agent per client)

---

## 4. TARGET USERS

### Primary ICP: AI Automation Agencies
- Running 10–50 client-deployed agents
- Monthly burn $2K–$30K on LLM APIs + infra
- Client-facing accountability (SLAs, uptime promises)
- Currently: no visibility into failures until the client calls

### Secondary ICP: Multi-Agent Operators (like MDI)
- Running large agent collectives (10–100 agents)
- Internal operations, no external clients
- Need to know when agents stop producing useful output

### Tertiary: SaaS companies with embedded AI
- Customer-facing agent features
- Responsible for uptime SLA

---

## 5. FAILURE TAXONOMY

Agent failures Sentinel detects:

| Type | Description | Severity |
|------|-------------|----------|
| Timeout | Agent exceeds max response time | High |
| Loop | Agent repeating same action 3+ times | High |
| Hallucination | Response contradicts known facts / safety rules | Critical |
| No-action | Agent received input, produced no output | Medium |
| Tool failure | External API call failed, agent didn't recover | High |
| Drift | Agent behavior statistically differs from baseline | Medium |
| Context overflow | Token limit hit, agent truncated context | Medium |
| Auth failure | Agent failed to authenticate to a required service | High |

---

## 6. CORE FEATURES (V1)

### 6.1 Sentinel SDK
```javascript
import { Sentinel } from '@agentsentinel/sdk';

const sentinel = new Sentinel({ apiKey: process.env.SENTINEL_KEY });

// Wrap any agent run
const result = await sentinel.monitor('agent-name', async () => {
  return await myAgent.run(input);
}, {
  maxDuration: 30000,      // timeout after 30s
  outcomeCheck: (r) => r.success,  // define what success looks like
  tags: { client: 'acme-corp', type: 'lead-qualification' }
});
```

### 6.2 Alert Routing
- Slack (primary)
- PagerDuty integration
- SMS via Twilio
- Email
- Webhook (custom)

Alert payload includes:
- Agent name + run ID
- Failure type + severity
- Client/tag context
- Full conversation transcript
- Suggested remediation action
- Link to run replay

### 6.3 Run Replay
Timeline view of every step in a failed run:
- Input received
- Tool calls made (with parameters)
- Intermediate outputs
- Final failure point
- Token usage per step

### 6.4 Escalation Workflow
1. Alert fires → assigned responder notified
2. Responder acknowledges (starts timer)
3. Human takes over the conversation/task OR marks agent as recovered
4. Resolution reason logged
5. Optional: auto-retry after human fixes root cause

### 6.5 Dashboard
- Active incidents (real-time)
- Agent health grid (green/yellow/red per agent)
- Incident history + resolution times
- Alert fatigue metrics (false positive rate)
- MTTR (mean time to resolve) per agent

---

## 7. CUSTOMER JOURNEYS

### Journey 1: Agency Operator — "The Silent Failure"

**Persona:** Sarah, runs an AI automation agency. 18 client agents deployed.

**Before Sentinel:**
1. Client "TechCorp" deploys a lead qualification agent Friday at 5pm
2. Agent starts looping on ambiguous inputs at 8pm
3. 47 leads go unqualified over the weekend
4. Monday: TechCorp calls Sarah angry
5. Sarah digs through logs for 3 hours to find the issue
6. Relationship damaged. SLA missed.

**With Sentinel:**
1. Agent starts looping at 8pm
2. Sentinel detects loop pattern at 8:03pm
3. Sarah receives Slack alert: "TechCorp Lead Agent: Loop detected. 3 identical tool calls in 90s. 4 leads affected. [View replay]"
4. Sarah clicks replay, sees the ambiguous input pattern
5. Fixes the prompt, deploys. Total downtime: 12 minutes.
6. Sentinel auto-generates incident report for client.

**Outcome:** Client never knows there was a problem. SLA maintained.

---

### Journey 2: Multi-Agent Operator — "The Drift Problem"

**Persona:** moonbags, running 36 agents in MDI collective.

**Before Sentinel:**
1. MDI produces 100 fragments per window normally
2. One agent cluster starts drifting — producing low-quality outputs
3. Fragment quality degrades over 3 days
4. Noticed only when reviewing outputs manually
5. Hard to trace which agent cluster caused it

**With Sentinel:**
1. Sentinel establishes baseline: fragment quality score 7.2/10 avg
2. Day 2: Agent cluster 4 drops to 5.1/10
3. Alert: "MDI Scout Cluster 4: Behavioral drift detected. Quality score -29% vs baseline. [View comparison]"
4. moonbags reviews — found prompt context window filling up
5. Fix deployed. Back to 7.4/10 within 2 hours.

**Outcome:** 3-day degradation caught in 4 hours.

---

### Journey 3: SaaS Team — "The Customer-Facing Failure"

**Persona:** Dev team at B2B SaaS, embedded AI support agent.

**Before Sentinel:**
1. Support agent starts hallucinating incorrect pricing info
2. 12 customers receive wrong quotes
3. Discovered via support ticket spike 2 days later
4. $30K in refunds/goodwill credits

**With Sentinel:**
1. Safety rule configured: agent response must not include dollar amounts without querying pricing API
2. First violation: alert fires immediately
3. Agent paused automatically (circuit breaker)
4. Dev team notified: "Pricing hallucination detected. 1 user affected. Agent auto-paused. [Review]"
5. Fix deployed in 20 minutes. 1 customer affected instead of 12.

---

## 8. UI/UX DESCRIPTIONS

### 8.1 Dashboard (Home)

**Layout:** Dark theme, three-panel layout

**Top bar:** 
- Agent health summary: `36 agents | 34 healthy | 1 warning | 1 incident`
- Last checked: `2 seconds ago`
- Global mute / maintenance mode toggle

**Left panel: Agent Grid**
- Cards for each agent, color-coded (green/yellow/red)
- Card shows: agent name, client tag, last run status, uptime %
- Click → Agent Detail

**Center panel: Active Incidents**
- Real-time incident feed
- Each incident: severity badge, agent name, failure type, time elapsed, assignee
- Quick actions: Acknowledge / Resolve / Reassign

**Right panel: Alert Queue**
- Pending alerts not yet acknowledged
- Sorted by severity
- One-click acknowledge

---

### 8.2 Incident Detail View

**Header:**
- Incident ID, severity badge, status
- Agent: `[agent-name]` | Client: `[client-tag]` | Started: `14 minutes ago`
- Responder: assigned to [name]

**Tab: Run Replay**
- Timeline visualization
- Each step: timestamp, action, tool called, parameters, response
- Failure point highlighted in red
- Token count per step on hover

**Tab: Alert History**
- When alert was generated
- Who was notified, when they acknowledged
- Chain of notifications (if escalated)

**Tab: Agent Context**
- System prompt (sanitized)
- Input that triggered the failure
- Recent successful runs for comparison

**Tab: Resolution**
- Resolution type: [Fixed / Workaround / Client notified / False positive]
- Root cause field (free text)
- Resolution notes
- Time to resolve

**Actions bar:**
- `Acknowledge` / `Reassign` / `Resolve` / `Auto-retry` / `Pause agent` / `Notify client`

---

### 8.3 Agent Detail View

**Header:**
- Agent name, status, tags
- Uptime badge: `99.2% (7 days)`

**Metrics row:**
- Total runs: 1,247
- Success rate: 97.4%
- Avg response time: 4.2s
- Incidents this week: 2
- MTTR: 8 min

**Run History**
- Table: run ID, timestamp, input summary, outcome, duration, tokens
- Clickable rows → Run replay

**Baseline config**
- Expected success rate range: 95–100%
- Max response time: 30s
- Quality score threshold: 6.5/10
- Alert on drift: enabled

**Alert config**
- Routes alerts to: #engineering-oncall (Slack)
- Escalate after: 10 minutes unacknowledged → SMS

---

### 8.4 Onboarding Flow

**Step 1: Connect your stack**
- Select framework: LangChain / AutoGen / CrewAI / OpenClaw / Custom
- Copy SDK install command
- Paste API key

**Step 2: Wrap one agent**
- Code snippet with agent name placeholder
- "Test run" button — fires a test alert to confirm wiring

**Step 3: Configure alerts**
- Connect Slack workspace → select channel
- Add phone number for SMS (optional)
- Invite team members

**Step 4: Set your first baseline**
- Run the agent 10 times in test mode
- Sentinel auto-generates baseline from results
- Adjust thresholds if needed

**Done:** "Your first agent is monitored. You'll know about failures before your users do."

---

## 9. TECHNICAL ARCHITECTURE

```
Agent Code (customer's)
    ↓
Sentinel SDK (lightweight wrapper)
    ↓
Sentinel API (hosted, GCP)
    ├── Real-time event stream (WebSocket)
    ├── Failure detection engine
    ├── Baseline comparison
    └── Alert router
         ├── Slack
         ├── PagerDuty
         ├── SMS (Twilio)
         └── Webhook
    ↓
Dashboard (React, real-time)
    ↓
Data store (Postgres + TimescaleDB for time-series)
```

**Key design decisions:**
- SDK is < 5KB, zero dependencies
- All agent data stays encrypted at rest
- Customer can self-host the data store (enterprise tier)
- No LLM calls in the monitoring path (deterministic detection)
- WebSocket for real-time dashboard updates

---

## 10. BUSINESS MODEL

**Pricing tiers:**

| Tier | Price | Limits |
|------|-------|--------|
| Starter | $99/mo | 5 agents, 1,000 monitored runs/mo |
| Growth | $399/mo | 25 agents, 10,000 runs/mo |
| Scale | $999/mo | 100 agents, unlimited runs |
| Enterprise | Custom | Unlimited + self-host option |

**Add-ons:**
- Incident report generator (client-ready PDF): $49/mo
- x402 billing integration: $99/mo (future)
- CFO dashboard (margin per agent): included in Scale+

---

## 11. MILESTONES

**Week 1:** SDK + Slack alerts working. 3 design partners using on real agents.
**Week 2:** Run replay + dashboard alpha. 10 design partners.
**Week 3:** Baseline detection + drift alerts. First $99 charges.
**Week 4:** Self-serve onboarding. 20 customers. Case study published.

**Month 2:** Escalation workflows + client-facing reports. Expand to 50 customers.
**Month 3:** CFO overlay (cost per agent). ARR path to $200K visible.

---

## 12. RISKS

| Risk | Mitigation |
|------|------------|
| LangSmith ships alerts | Go deeper: handoff, auto-retry, client reports — not just alerts |
| False positives erode trust | Baseline calibration during onboarding + feedback loop |
| Enterprise security concerns | SOC2 roadmap, self-host option |
| SDK adoption friction | <5 lines to integrate, no dependencies |
| Low volume agents (no failures to detect) | Value prop during setup: "know your baseline before you scale" |

---

*Saved: /root/.openclaw/workspace/plans/agent-sentinel-prd.md*
*Next: customer outreach templates, demo script, technical build spec*
