"""
zehrava-gate Python SDK
Write-path control plane for AI agents.

Usage:
    from zehrava_gate import Gate, GateError

    gate = Gate(endpoint="http://localhost:4000", api_key="gate_sk_...")
    p = gate.propose(
        payload="Hello — your issue is resolved.",
        destination="zendesk.reply",
        policy="support-reply",
        record_count=1
    )
    # p["status"] → "approved" | "blocked" | "pending_approval" | "duplicate_blocked"
    # p["blockReason"] → set if status is "blocked" or "duplicate_blocked"
"""

import json
import urllib.request
import urllib.error
from typing import Optional, List, Any


class GateError(Exception):
    def __init__(self, message: str, status: int = None, body: dict = None):
        super().__init__(message)
        self.status = status
        self.body = body


class Gate:
    """
    Zehrava Gate client.

    Args:
        endpoint: URL of your Gate server (e.g. "http://localhost:4000")
        api_key:  API key from POST /v1/agents/register
    """

    def __init__(self, endpoint: str, api_key: str):
        if not endpoint:
            raise ValueError("endpoint is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key

    def _request(self, method: str, path: str, body: dict = None) -> dict:
        url  = f"{self.endpoint}{path}"
        data = json.dumps(body).encode() if body else None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type":  "application/json",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = {}
            try:
                body = json.loads(e.read())
            except Exception:
                pass
            raise GateError(body.get("error", f"HTTP {e.code}"), status=e.code, body=body)

    def propose(
        self,
        *,
        destination: str,
        policy: str,
        payload: Optional[str] = None,
        record_count: Optional[int] = None,
        estimated_value_usd: Optional[float] = None,
        sensitivity_tags: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
        on_behalf_of: Optional[str] = None,
        expires_in: str = "1h",
        metadata: Optional[dict] = None,
    ) -> dict:
        """
        Submit an intent for policy evaluation.

        Returns dict with keys:
            intentId     — unique intent ID (int_…)
            status       — "approved" | "blocked" | "pending_approval" | "duplicate_blocked"
            risk_score   — composite 0–1 risk signal
            risk_level   — "low" | "medium" | "high" | "critical"
            blockReason  — set if status is "blocked" or "duplicate_blocked"
            expiresAt    — ISO timestamp of approval window expiry
        """
        return self._request("POST", "/v1/intents", {
            "destination":         destination,
            "policy":              policy,
            "payload":             payload,
            "recordCount":         record_count,
            "estimated_value_usd": estimated_value_usd,
            "sensitivity_tags":    sensitivity_tags,
            "idempotency_key":     idempotency_key,
            "on_behalf_of":        on_behalf_of,
            "expiresIn":           expires_in,
            "metadata":            metadata,
        })

    def approve(self, *, intent_id: str) -> dict:
        """Approve a pending intent. Returns {status, approvedAt}."""
        return self._request("POST", f"/v1/intents/{intent_id}/approve", {})

    def reject(self, *, intent_id: str, reason: Optional[str] = None) -> dict:
        """Reject a pending intent."""
        return self._request("POST", f"/v1/intents/{intent_id}/reject", {"reason": reason})

    def execute(self, *, intent_id: str) -> dict:
        """
        Request a signed execution order for an approved intent.
        Returns a one-time gex_ token (15 min TTL).
        Worker uses execution_token to perform the write in your VPC.

        Returns dict with keys:
            executionId      — exe_… ID
            execution_token  — gex_… one-time token, 15min TTL
            intent_id
            expires_at
            mode             — "runner_exec"
        """
        return self._request("POST", f"/v1/intents/{intent_id}/execute", {})

    def verify(self, *, intent_id: str) -> dict:
        """Fetch full intent details including policy decision and audit trail."""
        return self._request("GET", f"/v1/intents/{intent_id}")

    def register_webhook(
        self,
        *,
        intent_id: str,
        url: str,
        secret: Optional[str] = None,
    ) -> dict:
        """
        Register a webhook URL for intent state transitions.
        Gate fires once — on approved or rejected.
        Payload includes: intentId, event, actor, firedAt.
        Secret is sent as X-Gate-Secret header.
        """
        return self._request("POST", "/v1/webhooks/register", {
            "intentId": intent_id,
            "url":      url,
            "secret":   secret,
        })
