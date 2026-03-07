# Agent Sentinel — API Spec
*v1.0 | March 2026*

---

## Base URL

```
https://api.agentsentinel.dev/v1
```

All requests authenticated via `Authorization: Bearer <api_key>` header.

---

## Authentication

### POST /auth/keys
Create a new API key for an agent or service.

**Request:**
```json
{
  "name": "kaicalls-lead-outreach",
  "agent_id": "uuid",
  "scopes": ["events:write", "heartbeats:write"]
}
```

**Response:**
```json
{
  "key_id": "key_01HXYZ",
  "api_key": "sk_live_...",
  "created_at": "2026-03-07T09:00:00Z"
}
```

---

## Agents

### POST /agents
Register an agent with Sentinel.

**Request:**
```json
{
  "name": "kaicalls-lead-outreach",
  "description": "Processes new KaiCalls leads and sends outreach emails",
  "tags": ["kaicalls", "email", "cron"],
  "alert_channels": [
    { "type": "discord", "webhook_url": "https://discord.com/api/webhooks/..." },
    { "type": "slack",   "webhook_url": "https://hooks.slack.com/..." }
  ]
}
```

**Response:**
```json
{
  "agent_id": "agt_01HXYZ",
  "name": "kaicalls-lead-outreach",
  "created_at": "2026-03-07T09:00:00Z"
}
```

### GET /agents
List all registered agents.

### GET /agents/:agent_id
Get agent details + current health status.

---

## Runs

### POST /runs
Start a new agent run. Returns a `run_id` to attach events to.

**Request:**
```json
{
  "agent_id": "agt_01HXYZ",
  "trigger": "cron",
  "metadata": {
    "cron_expression": "0 */30 * * * *",
    "host": "89.167.60.171"
  }
}
```

**Response:**
```json
{
  "run_id": "run_01HABC",
  "agent_id": "agt_01HXYZ",
  "status": "running",
  "started_at": "2026-03-07T09:30:00Z"
}
```

### POST /runs/:run_id/end
Close out a run with final status.

**Request:**
```json
{
  "status": "success" | "failed" | "timeout",
  "summary": "Processed 3 leads. 2 emails sent.",
  "metadata": {}
}
```

### GET /runs/:run_id
Get run details + all attached events.

### GET /agents/:agent_id/runs
List recent runs for an agent. Query params: `?limit=20&status=failed`

---

## Events

### POST /events
Emit a structured event during a run. This is the primary ingest endpoint.

**Request:**
```json
{
  "run_id": "run_01HABC",
  "agent_id": "agt_01HXYZ",
  "event_type": "tool_call" | "tool_error" | "step" | "loop_detected" | "context_warning" | "custom",
  "severity": "info" | "warn" | "error" | "critical",
  "message": "Hunter.io API returned 429",
  "metadata": {
    "tool": "hunter_verify",
    "status_code": 429,
    "retry_count": 3
  },
  "timestamp": "2026-03-07T09:30:05Z"
}
```

**Response:**
```json
{
  "event_id": "evt_01HDEF",
  "incident_id": null,
  "alerted": false
}
```

If the event triggers incident creation, `incident_id` is populated and `alerted: true`.

### GET /runs/:run_id/events
List all events for a run.

---

## Heartbeats

### POST /heartbeats/register
Register a named heartbeat. Sentinel expects a ping within `interval_seconds`; missed pings fire an alert.

**Request:**
```json
{
  "name": "abp-lead-webhook-handler",
  "agent_id": "agt_01HXYZ",
  "interval_seconds": 1800,
  "grace_seconds": 120,
  "alert_channels": ["discord"]
}
```

**Response:**
```json
{
  "heartbeat_id": "hb_01HGHI",
  "ping_url": "https://api.agentsentinel.dev/v1/heartbeats/hb_01HGHI/ping"
}
```

### POST /heartbeats/:heartbeat_id/ping
Emit a heartbeat ping. Call this at the end of every successful cron run.

**Request:** Empty body or optional `{"metadata": {}}`.

**Response:**
```json
{
  "heartbeat_id": "hb_01HGHI",
  "received_at": "2026-03-07T09:30:00Z",
  "next_expected_by": "2026-03-07T10:02:00Z"
}
```

### GET /heartbeats
List all registered heartbeats + current status.

---

## Incidents

### GET /incidents
List all incidents. Query params: `?status=open&agent_id=agt_01HXYZ`

### GET /incidents/:incident_id
Get full incident detail including attached events and timeline.

**Response:**
```json
{
  "incident_id": "inc_01HJKL",
  "agent_id": "agt_01HXYZ",
  "run_id": "run_01HABC",
  "failure_type": "tool_error_threshold" | "loop" | "timeout" | "cron_miss" | "no_response" | "context_overflow",
  "severity": "warn" | "error" | "critical",
  "status": "open" | "acknowledged" | "resolved",
  "title": "kaicalls-lead-outreach: 5 tool errors in 60s",
  "summary": "Hunter.io verify calls failing with 429. 5 errors in last 60 seconds.",
  "replay_context": {
    "events": [...],
    "run_snapshot": {}
  },
  "opened_at": "2026-03-07T09:30:10Z",
  "acknowledged_at": null,
  "resolved_at": null
}
```

### POST /incidents/:incident_id/acknowledge
Acknowledge an incident. Silences repeat alerts.

**Request:**
```json
{
  "acknowledged_by": "moonbags",
  "note": "Rate limit hit, retrying in 1h"
}
```

### POST /incidents/:incident_id/resolve
Mark incident resolved.

---

## Alert Webhooks

Sentinel POSTs to your registered webhook URLs when an incident opens.

**Payload:**
```json
{
  "event": "incident.opened",
  "incident_id": "inc_01HJKL",
  "agent_name": "kaicalls-lead-outreach",
  "failure_type": "tool_error_threshold",
  "severity": "error",
  "title": "kaicalls-lead-outreach: 5 tool errors in 60s",
  "summary": "Hunter.io verify calls failing. 5 errors in 60 seconds.",
  "replay_url": "https://app.agentsentinel.dev/incidents/inc_01HJKL",
  "fired_at": "2026-03-07T09:30:10Z"
}
```

---

## Failure Detection Rules

Sentinel applies these deterministic rules to incoming events. No LLM calls.

| Rule | Trigger | Default Threshold |
|------|---------|------------------|
| `tool_error_threshold` | X tool errors within Y seconds | 5 errors / 60s |
| `loop_detected` | Same step/tool called N times in sequence | 3 identical consecutive calls |
| `timeout` | Run exceeds max duration | 300s (configurable) |
| `no_response` | No events received after run started | 60s |
| `cron_miss` | Heartbeat not received within interval + grace | per heartbeat config |
| `context_overflow` | Agent emits context_warning event | immediate |

All thresholds configurable per agent via `POST /agents/:agent_id/rules`.

---

*Next: DB schema, then Day 1 build*
