"""
Agent Sentinel Python SDK
Lightweight client for instrumenting Python-based agent flows.
"""
import os
import time
import requests
import functools
import traceback
from typing import Optional, Dict, Any

SENTINEL_ENDPOINT = os.getenv("SENTINEL_ENDPOINT", "http://localhost:3000/v1")
SENTINEL_API_KEY = os.getenv("SENTINEL_API_KEY", "")
AGENT_ID = os.getenv("SENTINEL_AGENT_ID", "unknown")
TIMEOUT = 3  # Never block agent flow for more than 3s


def _headers():
    return {"Authorization": f"Bearer {SENTINEL_API_KEY}", "Content-Type": "application/json"}


def _post(path: str, data: dict) -> Optional[dict]:
    """Fire-and-forget POST. Never raises."""
    try:
        r = requests.post(f"{SENTINEL_ENDPOINT}{path}", json=data, headers=_headers(), timeout=TIMEOUT)
        return r.json()
    except Exception:
        return None


def start_run(trigger: str = "cron", metadata: Optional[Dict] = None) -> Optional[str]:
    """Start a monitored run. Returns run_id."""
    result = _post("/runs", {
        "agent_id": AGENT_ID,
        "trigger": trigger,
        "metadata": metadata or {}
    })
    return result.get("run_id") if result else None


def end_run(run_id: str, status: str = "success", summary: str = "") -> None:
    """Close out a run."""
    try:
        requests.post(
            f"{SENTINEL_ENDPOINT}/runs/{run_id}/end",
            json={"status": status, "summary": summary},
            headers=_headers(),
            timeout=TIMEOUT
        )
    except Exception:
        pass


def event(run_id: str, event_type: str, message: str, severity: str = "info", metadata: Optional[Dict] = None) -> None:
    """Emit an event on a run."""
    _post("/events", {
        "run_id": run_id,
        "agent_id": AGENT_ID,
        "event_type": event_type,
        "severity": severity,
        "message": message,
        "metadata": metadata or {},
        "timestamp": int(time.time() * 1000)
    })


def tool_call(run_id: str, tool_name: str, metadata: Optional[Dict] = None) -> None:
    event(run_id, "tool.call", f"Tool called: {tool_name}", metadata={"tool": tool_name, **(metadata or {})})


def tool_error(run_id: str, tool_name: str, error: str, retry_count: int = 0) -> None:
    event(run_id, "tool.failure", f"Tool failed: {tool_name} — {error}", severity="error",
          metadata={"tool": tool_name, "error": error, "retry_count": retry_count})


def ping(heartbeat_id: str) -> None:
    """Ping a registered heartbeat."""
    try:
        requests.post(
            f"{SENTINEL_ENDPOINT}/heartbeats/{heartbeat_id}/ping",
            headers=_headers(),
            timeout=TIMEOUT
        )
    except Exception:
        pass


def register_heartbeat(name: str, interval_seconds: int = 1800, grace_seconds: int = 120) -> Optional[str]:
    """Register a heartbeat. Returns heartbeat_id."""
    result = _post("/heartbeats/register", {
        "name": name,
        "agent_id": AGENT_ID,
        "interval_seconds": interval_seconds,
        "grace_seconds": grace_seconds
    })
    return result.get("heartbeat_id") if result else None


def monitor(run_name: str = None, trigger: str = "cron"):
    """
    Decorator to auto-instrument a function as a monitored run.

    Usage:
        @sentinel.monitor("abp-lead-handler")
        def run():
            ...
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            name = run_name or fn.__name__
            run_id = start_run(trigger=trigger, metadata={"script": name})
            try:
                result = fn(*args, **kwargs)
                end_run(run_id, status="success", summary=f"{name} completed")
                return result
            except Exception as e:
                event(run_id, "run.fail", str(e), severity="error",
                      metadata={"traceback": traceback.format_exc()})
                end_run(run_id, status="failed", summary=str(e))
                raise
        return wrapper
    return decorator
