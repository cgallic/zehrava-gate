"""
zehrava-gate Python SDK
The safe commit layer for AI agents.

Usage:
    from zehrava_gate import Gate

    gate = Gate(endpoint="http://localhost:4000", api_key="gate_sk_...")
    p = gate.propose(payload="Hello!", destination="zendesk.reply", policy="support-reply", record_count=1)
    print(p["status"])  # approved | blocked | pending_approval
"""

import json
import urllib.request
import urllib.error
from typing import Optional, Any


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
        api_key:  API key from /v1/agents/register
    """

    def __init__(self, endpoint: str, api_key: str):
        if not endpoint:
            raise ValueError("endpoint is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key

    def _request(self, method: str, path: str, body: dict = None) -> dict:
        url = f"{self.endpoint}{path}"
        data = json.dumps(body).encode() if body else None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
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
        expires_in: str = "1h",
        on_behalf_of: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> dict:
        """
        Propose an agent action for policy evaluation.

        Returns dict with keys: proposalId, status, blockReason, expiresAt
        status is one of: "approved", "blocked", "pending_approval"
        """
        return self._request("POST", "/v1/propose", {
            "destination": destination,
            "policy": policy,
            "payload": payload,
            "recordCount": record_count,
            "expiresIn": expires_in,
            "on_behalf_of": on_behalf_of,
            "metadata": metadata,
        })

    def approve(self, *, proposal_id: str) -> dict:
        """Approve a pending proposal. Returns deliveryToken."""
        return self._request("POST", "/v1/approve", {"proposalId": proposal_id})

    def reject(self, *, proposal_id: str, reason: Optional[str] = None) -> dict:
        """Reject a pending proposal."""
        return self._request("POST", "/v1/reject", {"proposalId": proposal_id, "reason": reason})

    def deliver(self, *, proposal_id: str) -> dict:
        """Get one-time delivery URL for an approved proposal."""
        return self._request("POST", "/v1/deliver", {"proposalId": proposal_id})

    def verify(self, *, proposal_id: str) -> dict:
        """Get full proposal details and audit trail."""
        return self._request("GET", f"/v1/proposals/{proposal_id}")

    def register_webhook(self, *, proposal_id: str, url: str, secret: Optional[str] = None) -> dict:
        """Register a webhook URL to be called when a proposal is approved or rejected."""
        return self._request("POST", "/v1/webhooks/register", {
            "proposalId": proposal_id,
            "url": url,
            "secret": secret,
        })
