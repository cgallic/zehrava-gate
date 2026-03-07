# Agent Sentinel — Week 1 Implementation Spec

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Agent Code    │────▶│  Sentinel SDK    │────▶│  Sentinel API   │
│  (Wrapped)      │     │  (JS/Python)     │     │   (Node.js)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │                           │
                              ▼                           ▼
                       ┌──────────────┐          ┌──────────────┐
                       │  Local Queue │          │   SQLite     │
                       │   (BullMQ)   │          │   (Events)   │
                       └──────────────┘          └──────────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────┐
                                                  │ Alert Router │
                                                  │(Discord/Slack│
                                                  └──────────────┘
```

## Week 1 Deliverables

### Day 1-2: Core API + SDK
- [ ] API server scaffold (Node.js/Express)
- [ ] Event ingestion endpoint `POST /v1/events`
- [ ] SQLite schema for events, incidents, alerts
- [ ] JS SDK wrapper (`sentinel.wrap()`)
- [ ] Basic event types: `run.start`, `run.step`, `run.complete`, `run.fail`

### Day 3-4: Detection Engine
- [ ] Failure detectors:
  - Timeout (configurable threshold)
  - Loop detection (repeated same action)
  - Tool failure (error responses)
  - Cron miss (expected vs actual run times)
- [ ] Incident creation with severity (P0/P1/P2)
- [ ] Incident grouping (same agent, same failure type)

### Day 5-7: Alerting + Dogfood
- [ ] Discord webhook integration
- [ ] Alert payload with context:
  - Agent name, run ID
  - Failure type, severity
  - Last 5 events (replay context)
  - Timestamp, duration
- [ ] Dogfood on ABP webhook
- [ ] Dogfood on KaiCalls outreach script
- [ ] Dashboard stub (incident list view)

## Database Schema

```sql
-- Events (raw agent telemetry)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL, -- run.start, run.step, run.complete, run.fail
  payload JSON,
  timestamp INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Incidents (grouped failures)
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL, -- timeout, loop, tool_failure, cron_miss
  severity TEXT NOT NULL, -- P0, P1, P2
  status TEXT DEFAULT 'open', -- open, acknowledged, resolved
  first_event_id TEXT,
  last_event_id TEXT,
  event_count INTEGER DEFAULT 1,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  alert_sent BOOLEAN DEFAULT FALSE
);

-- Alerts (notification log)
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  channel TEXT NOT NULL, -- discord, slack
  payload JSON,
  sent_at INTEGER NOT NULL,
  response_status INTEGER
);
```

## SDK API (JavaScript)

```javascript
const sentinel = require('@agent-sentinel/sdk');

// Initialize
sentinel.init({
  apiKey: process.env.SENTINEL_API_KEY,
  endpoint: 'https://sentinel.snappedai.com/v1',
  agentId: 'kaicalls-outreach',
  timeout: 30000, // 30s default
  maxLoopCount: 3
});

// Wrap any function
const wrappedRun = sentinel.wrap(async (lead) => {
  // Your agent logic here
  await sendEmail(lead);
  await updateCRM(lead);
  return { success: true };
});

// Use it
await wrappedRun(leadData);
```

## API Endpoints

```
POST /v1/events
  Body: { agent_id, run_id, type, payload, timestamp }
  Response: { event_id }

GET /v1/incidents
  Query: { agent_id, status, severity, limit }
  Response: { incidents: [...] }

POST /v1/incidents/:id/acknowledge
  Response: { incident_id, status: 'acknowledged' }

POST /v1/incidents/:id/resolve
  Response: { incident_id, status: 'resolved' }

GET /v1/health
  Response: { status: 'ok', version }
```

## File Structure

```
/tmp/agent-sentinel/
├── services/
│   └── sentinel-api/
│       ├── src/
│       │   ├── index.js           # Server entry
│       │   ├── routes/
│       │   │   ├── events.js      # Event ingestion
│       │   │   ├── incidents.js   # Incident management
│       │   │   └── health.js      # Health check
│       │   ├── detectors/
│       │   │   ├── timeout.js
│       │   │   ├── loop.js
│       │   │   ├── tool-failure.js
│       │   │   └── cron-miss.js
│       │   ├── alerts/
│       │   │   └── discord.js
│       │   └── db.js              # SQLite connection
│       ├── package.json
│       └── Dockerfile
├── sdk/
│   └── js/
│       ├── src/
│       │   ├── index.js
│       │   └── wrap.js
│       └── package.json
└── dashboard/
    └── (Week 2)
```

## Environment Variables

```bash
# API
PORT=3000
DATABASE_URL=./sentinel.db
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALERT_COOLDOWN_MS=300000  # 5 min between alerts for same incident

# SDK
SENTINEL_API_KEY=sk_...
SENTINEL_ENDPOINT=https://sentinel.snappedai.com/v1
```

## Week 1 Success Criteria

- [ ] SDK successfully wraps ABP webhook handler
- [ ] Timeout detection fires when handler takes >30s
- [ ] Discord alert received with full context
- [ ] Incident appears in SQLite with correct severity
- [ ] Can acknowledge/resolve via API
- [ ] Replay context shows last 5 events before failure

## Next (Week 2)

- Dashboard UI
- Slack integration
- Session replay timeline
- Auto-retry policies
- Python SDK
