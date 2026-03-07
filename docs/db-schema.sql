-- Agent Sentinel — Database Schema
-- v1.0 | March 2026
-- PostgreSQL + TimescaleDB for time-series event tables

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================
-- AGENTS
-- ============================================================

CREATE TABLE agents (
    agent_id        TEXT PRIMARY KEY DEFAULT 'agt_' || replace(gen_random_uuid()::text, '-', ''),
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    tags            TEXT[] DEFAULT '{}',
    alert_channels  JSONB DEFAULT '[]',   -- [{type, webhook_url}]
    rules           JSONB DEFAULT '{}',   -- per-agent threshold overrides
    status          TEXT NOT NULL DEFAULT 'active',  -- active | paused | archived
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- API KEYS
-- ============================================================

CREATE TABLE api_keys (
    key_id          TEXT PRIMARY KEY DEFAULT 'key_' || replace(gen_random_uuid()::text, '-', ''),
    agent_id        TEXT REFERENCES agents(agent_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,  -- bcrypt hash of the raw key
    scopes          TEXT[] DEFAULT '{}',
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

-- ============================================================
-- RUNS
-- ============================================================

CREATE TABLE runs (
    run_id          TEXT PRIMARY KEY DEFAULT 'run_' || replace(gen_random_uuid()::text, '-', ''),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    trigger         TEXT NOT NULL DEFAULT 'manual',  -- cron | webhook | manual | scheduled
    status          TEXT NOT NULL DEFAULT 'running', -- running | success | failed | timeout
    summary         TEXT,
    metadata        JSONB DEFAULT '{}',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    duration_ms     INTEGER GENERATED ALWAYS AS (
                        EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                    ) STORED
);

CREATE INDEX idx_runs_agent_id ON runs(agent_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_started_at ON runs(started_at DESC);

-- ============================================================
-- EVENTS (TimescaleDB hypertable)
-- ============================================================

CREATE TABLE events (
    event_id        TEXT NOT NULL DEFAULT 'evt_' || replace(gen_random_uuid()::text, '-', ''),
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,  -- tool_call | tool_error | step | loop_detected | context_warning | custom
    severity        TEXT NOT NULL DEFAULT 'info',  -- info | warn | error | critical
    message         TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}',
    incident_id     TEXT,           -- set if this event triggered/joined an incident
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, timestamp)
);

-- Convert to TimescaleDB hypertable (partition by timestamp, 1-day chunks)
SELECT create_hypertable('events', 'timestamp', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_events_run_id ON events(run_id, timestamp DESC);
CREATE INDEX idx_events_agent_id ON events(agent_id, timestamp DESC);
CREATE INDEX idx_events_severity ON events(severity, timestamp DESC);
CREATE INDEX idx_events_incident_id ON events(incident_id) WHERE incident_id IS NOT NULL;

-- ============================================================
-- HEARTBEATS
-- ============================================================

CREATE TABLE heartbeats (
    heartbeat_id        TEXT PRIMARY KEY DEFAULT 'hb_' || replace(gen_random_uuid()::text, '-', ''),
    agent_id            TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    interval_seconds    INTEGER NOT NULL DEFAULT 1800,
    grace_seconds       INTEGER NOT NULL DEFAULT 120,
    alert_channels      TEXT[] DEFAULT '{}',  -- subset of agent channels to use
    status              TEXT NOT NULL DEFAULT 'healthy',  -- healthy | missed | paused
    last_ping_at        TIMESTAMPTZ,
    next_expected_by    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_id, name)
);

CREATE TABLE heartbeat_pings (
    ping_id         TEXT PRIMARY KEY DEFAULT 'ping_' || replace(gen_random_uuid()::text, '-', ''),
    heartbeat_id    TEXT NOT NULL REFERENCES heartbeats(heartbeat_id) ON DELETE CASCADE,
    metadata        JSONB DEFAULT '{}',
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_heartbeat_pings_hb_id ON heartbeat_pings(heartbeat_id, received_at DESC);

-- ============================================================
-- INCIDENTS
-- ============================================================

CREATE TABLE incidents (
    incident_id     TEXT PRIMARY KEY DEFAULT 'inc_' || replace(gen_random_uuid()::text, '-', ''),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    failure_type    TEXT NOT NULL,  -- tool_error_threshold | loop | timeout | no_response | cron_miss | context_overflow
    severity        TEXT NOT NULL DEFAULT 'error',  -- warn | error | critical
    status          TEXT NOT NULL DEFAULT 'open',   -- open | acknowledged | resolved
    title           TEXT NOT NULL,
    summary         TEXT,
    replay_context  JSONB DEFAULT '{}',  -- snapshot of events + run state at incident time
    alert_sent_at   TIMESTAMPTZ,
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,
    ack_note        TEXT,
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_incidents_agent_id ON incidents(agent_id, opened_at DESC);
CREATE INDEX idx_incidents_status ON incidents(status, opened_at DESC);
CREATE INDEX idx_incidents_run_id ON incidents(run_id);

-- ============================================================
-- ALERT LOG
-- ============================================================

CREATE TABLE alert_log (
    alert_id        TEXT PRIMARY KEY DEFAULT 'alrt_' || replace(gen_random_uuid()::text, '-', ''),
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
    channel_type    TEXT NOT NULL,  -- discord | slack | sms | webhook
    destination     TEXT NOT NULL,  -- webhook URL or phone number (hashed for PII)
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent',  -- sent | failed | suppressed
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error           TEXT
);

CREATE INDEX idx_alert_log_incident ON alert_log(incident_id);

-- ============================================================
-- DETECTION STATE (in-memory equivalent, persisted for recovery)
-- ============================================================

-- Tracks rolling windows for loop and error threshold detection
CREATE TABLE detection_state (
    state_id        TEXT PRIMARY KEY DEFAULT 'ds_' || replace(gen_random_uuid()::text, '-', ''),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    rule            TEXT NOT NULL,  -- which rule this state belongs to
    window_start    TIMESTAMPTZ NOT NULL,
    event_count     INTEGER NOT NULL DEFAULT 0,
    last_event_at   TIMESTAMPTZ,
    last_step_hash  TEXT,  -- for loop detection: hash of last step signature
    consecutive     INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, rule)
);

-- ============================================================
-- RETENTION POLICY (TimescaleDB)
-- ============================================================

-- Auto-drop events older than 90 days
SELECT add_retention_policy('events', INTERVAL '90 days');

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
