# Zehrava Gate documentation

Markdown docs that live with the code. The hosted docs at
[zehrava.com/docs](https://zehrava.com/docs) are built from the same
material.

- [Quickstart](./quickstart.md) — first governed write in under 5 minutes
- [Policy reference](./policy-reference.md) — every YAML field, with the
  exact evaluation order the engine uses
- [A2H Layer 2 proposal](./a2h-layer2-proposal.md) — standing policies,
  revocation and delegation for the Agent-to-Human protocol (Twilio Ola),
  with Gate as the reference implementation
- [A2H Layer 3 proposal](./a2h-layer3-proposal.md) — execution grants,
  executor attestations and an offline-verifiable consent → execution →
  outcome bundle
- [HTTP API](../schemas/openapi.yaml) — OpenAPI 3.1 spec
- [JSON Schemas](../schemas/) — intent, agent, policy decision, execution
  order, audit event

## Packages

| Package | What it is | Docs |
|---|---|---|
| `zehrava-gate` (npm / PyPI) | Server + CLI + JS SDK; Python SDK on PyPI | [README](../README.md) |
| `zehrava-gate-mcp` | MCP server for Claude and other MCP hosts | [README](../packages/mcp-gate/README.md) |
| `zehrava-gate-langchain` | LangChain/LangGraph tool wrapper | [README](../packages/langchain-gate/README.md) |

## Contributing & security

- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev setup, tests, extension points
- [SECURITY.md](../SECURITY.md) — disclosure policy and threat-model scope
- [ROADMAP.md](../ROADMAP.md) — where the project is headed

`internal/` holds historical build specs kept for reference; nothing in it
is a contract.
