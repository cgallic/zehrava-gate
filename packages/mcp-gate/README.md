# zehrava-gate-mcp

An [MCP](https://modelcontextprotocol.io) server exposing Zehrava Gate's
human-in-the-loop approval and audit primitives to MCP-compatible agents
(Claude Desktop, Claude Code, and other MCP hosts) — without giving those
agents any way to bypass Gate's policy/approval/execution-token boundary.

No tool in this package can execute a write directly. Every tool is a thin
wrapper over Gate's existing HTTP API (`propose` / `approve`/`reject` /
`execute` / `audit`); an agent using only these tools can *request* that a
write happen and find out whether Gate allowed it, never make it happen on
its own.

## Setup

```bash
npm install zehrava-gate-mcp
```

Register a Gate agent to get an API key (`POST /v1/agents/register` against
a running `gate-server`, or via the SDK), then configure your MCP client:

```json
{
  "mcpServers": {
    "zehrava-gate": {
      "command": "npx",
      "args": ["zehrava-gate-mcp"],
      "env": {
        "GATE_ENDPOINT": "http://localhost:3001",
        "GATE_API_KEY": "gate_sk_..."
      }
    }
  }
}
```

## Tools

| Tool | Maps to | Notes |
|---|---|---|
| `gate_propose_intent` | `POST /v1/propose` | Returns immediately with the policy decision — does not wait for a human. |
| `gate_authorize_action` | propose + poll `GET /v1/intents/:id` + `POST /v1/intents/:id/execute` on approval | Blocks until a human decides or times out. On approval, also requests an execution token. This is the `human_authorize` primitive — it reports Gate's decision, it never substitutes for one. |
| `gate_collect_input` | same as `gate_authorize_action` | Reframes the response around the human's decision + any `reason` they gave, since Gate has no separate free-text collection channel — see [Design notes](#design-notes). |
| `gate_send_result` | `POST /v1/executions/:id/report` | Requires the `execution_id`/`execution_token` from `gate_authorize_action`'s `execution` field — this tool cannot execute anything itself. |
| `gate_get_status` | `GET /v1/intents/:id` | |
| `gate_get_audit` | `GET /v1/audit/:id` | |

All schemas are strict (Zod) — every write-intent tool requires an exact
`destination` and `policy`, matching Gate's own binding requirements; there
is no "just run this ambiguous action" tool.

## Demo: propose → approve → execute → result/audit

```bash
node examples/demo.js
```

Boots a local `gate-server`, calls `gate_authorize_action` (which proposes
an intent and blocks waiting for a decision), approves it from a second
"reviewer" context to simulate a human, and shows the tool receiving the
execution token, reporting a result via `gate_send_result`, and reading the
audit trail back via `gate_get_audit`.

## Design notes

- **`gate_collect_input` is not a general "ask anything" tool.** Gate's
  protocol has exactly one human decision primitive: approve/reject a
  proposed action, optionally with a `reason`. Mapping A2H's
  `human_collect` onto that honestly means the "collected input" is that
  decision + reason, not arbitrary free text. If you need real free-text
  collection, that's a genuinely different feature (see the open work list
  in the repo) — this tool doesn't pretend to be one.
- **Execution tokens are opaque to this package.** `gate_send_result`
  requires a token minted by Gate's own `POST /v1/intents/:id/execute` —
  there's no code path in this MCP server that can produce one without a
  prior verified approval.
- **Timeouts fail closed.** `gate_authorize_action`/`gate_collect_input`
  return `{ timedOut: true, status: 'pending_approval' }` rather than
  guessing a decision when the wait exceeds `timeout_ms`.
