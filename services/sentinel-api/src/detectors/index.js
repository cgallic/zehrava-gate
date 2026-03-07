const db = require('../db');

// Configuration
const CONFIG = {
  timeout: {
    defaultThreshold: 30000, // 30 seconds
  },
  loop: {
    maxRepetitions: 3,
    timeWindow: 60000, // 1 minute
  },
  cron: {
    gracePeriod: 300000, // 5 minutes
  }
};

// In-memory cache for loop detection (run_id -> recent event types)
const runCache = new Map();

function check(event) {
  const failures = [];
  
  // Check for timeout (from payload)
  if (event.type === 'run.timeout' || event.payload?.timeout) {
    failures.push({
      type: 'timeout',
      severity: 'P1',
      details: {
        threshold: event.payload.threshold || CONFIG.timeout.defaultThreshold,
        actual_duration: event.payload.duration
      }
    });
  }
  
  // Check for tool failure
  if (event.type === 'tool.failure' || event.payload?.tool_error) {
    failures.push({
      type: 'tool_failure',
      severity: 'P1',
      details: {
        tool: event.payload.tool,
        error: event.payload.error,
        retry_count: event.payload.retry_count || 0
      }
    });
  }
  
  // Check for explicit failure
  if (event.type === 'run.fail' || event.payload?.error) {
    failures.push({
      type: 'run_failure',
      severity: event.payload.severity || 'P2',
      details: {
        error: event.payload.error,
        step: event.payload.step
      }
    });
  }
  
  // Check for loop
  const loopFailure = checkForLoop(event);
  if (loopFailure) {
    failures.push(loopFailure);
  }
  
  return failures;
}

function checkForLoop(event) {
  const cacheKey = event.run_id;
  const now = Date.now();
  
  if (!runCache.has(cacheKey)) {
    runCache.set(cacheKey, []);
  }
  
  const runEvents = runCache.get(cacheKey);
  
  // Add current event
  runEvents.push({
    type: event.type,
    timestamp: now,
    payload: event.payload
  });
  
  // Clean old events outside window
  const cutoff = now - CONFIG.loop.timeWindow;
  while (runEvents.length > 0 && runEvents[0].timestamp < cutoff) {
    runEvents.shift();
  }
  
  // Check for repetition pattern
  const typeCounts = {};
  for (const e of runEvents) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count >= CONFIG.loop.maxRepetitions) {
      // Check if this is a "step" type (likely a loop)
      if (type === 'run.step' || type.includes('tool.call')) {
        return {
          type: 'loop',
          severity: 'P0',
          details: {
            repeated_type: type,
            repetition_count: count,
            time_window_ms: CONFIG.loop.timeWindow
          }
        };
      }
    }
  }
  
  return null;
}

// Cron miss detector (run this periodically, not per-event)
function checkCronMisses(agentId, expectedIntervalMinutes) {
  const recentEvents = db.getRecentEvents(agentId, expectedIntervalMinutes + 10);
  
  if (recentEvents.length === 0) {
    // No events in expected window + grace period
    return {
      type: 'cron_miss',
      severity: 'P1',
      details: {
        agent_id: agentId,
        expected_interval_minutes: expectedIntervalMinutes,
        last_seen: null
      }
    };
  }
  
  const lastEvent = recentEvents[0];
  const minutesSinceLast = (Date.now() - lastEvent.timestamp) / 60000;
  
  if (minutesSinceLast > expectedIntervalMinutes + 5) { // 5 min grace
    return {
      type: 'cron_miss',
      severity: 'P1',
      details: {
        agent_id: agentId,
        expected_interval_minutes: expectedIntervalMinutes,
        minutes_since_last: Math.round(minutesSinceLast),
        last_seen: lastEvent.timestamp
      }
    };
  }
  
  return null;
}

// Clean up old cache entries periodically
setInterval(() => {
  const cutoff = Date.now() - (10 * 60 * 1000); // 10 minutes
  for (const [key, events] of runCache.entries()) {
    if (events.length > 0 && events[events.length - 1].timestamp < cutoff) {
      runCache.delete(key);
    }
  }
}, 60000); // Run every minute

module.exports = {
  check,
  checkCronMisses,
  CONFIG
};
