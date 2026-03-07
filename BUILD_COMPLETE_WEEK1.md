# Agent Sentinel — Build Complete

## What's Built

### API Server (`services/sentinel-api/`)
- ✅ Event ingestion endpoint (`POST /v1/events`)
- ✅ Incident detection (timeout, loop, tool failure, run failure)
- ✅ Incident management (`GET /v1/incidents`, acknowledge, resolve)
- ✅ SQLite database with WAL mode
- ✅ Discord webhook alerts
- ✅ Agent registration
- ✅ Run replay (`GET /v1/runs/:runId/events`)

### SDK (`sdk/js/`)
- ✅ Function wrapper with automatic monitoring
- ✅ Step tracking for loop detection
- ✅ Tool call/failure tracking
- ✅ Auto-retry on failure
- ✅ Timeout detection

## Quick Start

### 1. Start the API
```bash
cd services/sentinel-api
npm install
npm run db:migrate
DISCORD_WEBHOOK_URL=your_webhook node src/index.js
```

### 2. Use the SDK
```javascript
const sentinel = require('@agent-sentinel/sdk');

sentinel.init({
  apiKey: 'your-key',
  endpoint: 'http://localhost:3000/v1',
  agentId: 'my-agent'
});

// Wrap any function
const monitoredFunction = sentinel.wrap(async (data) => {
  // Your agent logic
  await doSomething(data);
  return result;
}, { name: 'my-task', timeout: 30000 });

// Run it
await monitoredFunction(data);
```

### 3. Get Alerts
When a failure is detected, you'll get a Discord message with:
- Failure type and severity
- Agent and run ID
- Recent events (replay context)
- Direct links to investigate

## Week 1 Status

- [x] API server scaffold
- [x] Database schema
- [x] Event ingestion
- [x] Incident detection (timeout, loop, tool failure)
- [x] Discord alerts
- [x] JS SDK
- [ ] Dashboard UI (Week 2)
- [ ] Python SDK (Week 2)
- [ ] Cron miss detector (Week 2)

## Dogfood Targets

1. **ABP webhook handler** — wrap and monitor
2. **KaiCalls outreach script** — detect timeouts/failures
3. **Daily report cron** — cron miss detection
4. **This agent (SnappedAI)** — heartbeat monitoring

Ready for dogfood deployment.
