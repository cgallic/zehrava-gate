# zehrava-gate (Python)

**The safe commit layer for AI agents.**

→ [zehrava.com](https://zehrava.com) · [Docs](https://zehrava.com/docs) · [npm package](https://www.npmjs.com/package/zehrava-gate)

## Install

```bash
pip install zehrava-gate
```

## Usage

```python
from zehrava_gate import Gate

gate = Gate(
    endpoint="http://localhost:4000",
    api_key="gate_sk_..."
)

p = gate.propose(
    payload="Thank you — your issue is resolved.",
    destination="zendesk.reply",
    policy="support-reply",
    record_count=1
)

print(p["status"])       # approved | blocked | pending_approval
print(p["block_reason"]) # set if blocked

# Register webhook to be notified on approval
gate.register_webhook(
    proposal_id=p["proposalId"],
    url="https://your-app.com/gate-webhook",
    secret="your-secret"
)
```

## LangGraph example

```python
from langgraph.graph import StateGraph
from zehrava_gate import Gate, GateError

gate = Gate(endpoint="http://localhost:4000", api_key="gate_sk_...")

def send_reply(state):
    p = gate.propose(
        payload=state["reply"],
        destination="zendesk.reply",
        policy="support-reply",
        record_count=1
    )
    if p["status"] == "blocked":
        raise GateError(f"Blocked: {p['blockReason']}")
    if p["status"] == "pending_approval":
        return {**state, "status": "awaiting_approval", "proposal_id": p["proposalId"]}
    # approved — deliver
    return {**state, "status": "sent"}
```

## Methods

| Method | Description |
|--------|-------------|
| `propose(destination, policy, payload, record_count, ...)` | Submit action for policy evaluation |
| `approve(proposal_id)` | Approve a pending proposal |
| `reject(proposal_id, reason)` | Reject a pending proposal |
| `deliver(proposal_id)` | Get one-time delivery URL |
| `verify(proposal_id)` | Full proposal + audit trail |
| `register_webhook(proposal_id, url, secret)` | Webhook on approve/reject |

## License

MIT
