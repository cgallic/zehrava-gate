"""
zehrava_gate — Safe commit layer for AI agents.

Usage:
    from zehrava_gate import Gate

    gate = Gate(endpoint="http://localhost:3001", api_key="gate_sk_...")
    proposal = gate.propose(payload="./leads.csv", destination="salesforce.import", policy="crm-low-risk")
    print(proposal["status"])  # approved | pending_approval | blocked
"""

import json
import urllib.request
import urllib.error
from urllib.parse import urljoin


class GateError(Exception):
    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class Gate:
    def __init__(self, endpoint: str, api_key: str):
        if not endpoint:
            raise ValueError("endpoint is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key

    def _request(self, method: str, path: str, body=None):
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
            raw = e.read()
            try:
                parsed = json.loads(raw)
                raise GateError(parsed.get("error", str(e)), status=e.code, body=parsed)
            except json.JSONDecodeError:
                raise GateError(str(e), status=e.code)

    def propose(self, *, payload: str, destination: str, policy: str,
                expires_in: str = "1h", record_count: int = None, metadata: dict = None):
        """
        Propose an agent output for policy evaluation and approval.

        Returns:
            dict with keys: proposalId, status, blockReason, expiresAt
            status: 'approved' | 'blocked' | 'pending_approval'
        """
        body = {
            "payload": payload,
            "destination": destination,
            "policy": policy,
            "expiresIn": expires_in,
        }
        if record_count is not None:
            body["recordCount"] = record_count
        if metadata:
            body["metadata"] = metadata
        return self._request("POST", "/v1/propose", body)

    def approve(self, *, proposal_id: str):
        """Approve a pending proposal."""
        return self._request("POST", "/v1/approve", {"proposalId": proposal_id})

    def reject(self, *, proposal_id: str, reason: str = None):
        """Reject a pending proposal."""
        return self._request("POST", "/v1/reject", {"proposalId": proposal_id, "reason": reason})

    def deliver(self, *, proposal_id: str):
        """Get a one-time delivery URL for an approved proposal."""
        return self._request("POST", "/v1/deliver", {"proposalId": proposal_id})

    def verify(self, *, proposal_id: str):
        """Get full proposal details and audit trail."""
        return self._request("GET", f"/v1/proposals/{proposal_id}")
