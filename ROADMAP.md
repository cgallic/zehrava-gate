# Zehrava Gate — Roadmap: Becoming the Default Write-Path Control Plane for Agentic Builders

> Goal: a builder integrating any agent framework should reach their first
> governed write in under 5 minutes, trust the project on sight, and find a
> ready-made integration for whatever stack they're on. This document is the
> prioritized plan to get there, grounded in an audit of the repo as of
> July 2026 (v0.3.0, 23/23 server tests passing).

---

## Where we stand

**Strong core, weak adoption surface.**

What's already excellent:

- Deterministic YAML policy engine, fail-closed lifecycle, signed execution
  orders (`gex_` tokens), idempotency, full audit trail
- Layer 2 authority model: standing approvals, delegation, N-of-M quorum,
  timeout defaults, risk-tiered assurance
- Approval providers (KaiCalls voice, A2H bridge) with signed callbacks,
  replay protection, and an E2E adversarial test harness
- MCP server (`packages/mcp-gate`) that exposes approval primitives without
  ever letting an agent bypass the execution-token boundary
- LangChain/LangGraph wrapper, JS + Python SDKs, forward-proxy (V3) design
- `npx zehrava-gate demo`, live demo + dashboard at zehrava.com

What's holding adoption back (verified, not guessed):

| Gap | Detail |
|---|---|
| No `LICENSE` file | README says MIT, but the repo has no license file — legal blocker for many companies |
| No CI | No `.github/` at all: the 23-test suite runs only on maintainer machines; no badge, no PR checks |
| MCP server unpublished | `zehrava-gate-mcp` is not on npm; the README tells users to `npm install` a package that 404s |
| Package naming drift | JS SDK is `@kaicmo/gate`; langchain README says `@zehrava/langchain-gate` but package.json says `zehrava-gate-langchain`; server package doubles as the SDK |
| Duplicate Python SDK | `packages/gate-sdk-py` and `packages/gate-sdk-python` both exist and differ |
| Stale internal spec | `SPEC.md` references `/opt/`, PM2, and Caddy paths from the production box — confusing as the repo's front-page spec |
| No repo-native docs | Docs are HTML on the landing site; nothing agents or contributors can read as markdown in-repo |
| No root workspace | No root `package.json`; each package is installed and tested in isolation by hand |
| No contribution surface | No CONTRIBUTING, SECURITY.md, CHANGELOG, issue/PR templates, or Discussions |

---

## Phase 0 — Trust signals (days, not weeks)

Everything here is table stakes; a builder evaluating Gate bounces in the
first 90 seconds without them.

1. **Add `LICENSE` (MIT)** at repo root.
2. **GitHub Actions CI**: run `gate-server` tests + `mcp-gate` tests +
   langchain dry-run on push/PR across Node 18/20/22; add the badge to
   README. The suite is already fast and hermetic — this is a
   half-day task with outsized signaling value.
3. **`CONTRIBUTING.md`** — how to run the server, run tests, add a policy
   field, add an approval provider (the provider interface is the most
   likely community contribution point).
4. **`SECURITY.md`** — Gate is a security product; a disclosure policy is
   non-negotiable. Include the "honest scope" threat model (protects
   against mistakes, not rogue agents) so researchers know what's in scope.
5. **`CHANGELOG.md`** — backfill from the existing release history
   (0.1 → 0.3), keep-a-changelog format.
6. **Issue templates + PR template** — bug / integration request / policy
   feature; template asks for policy YAML + intent payload to reproduce.
7. **Retire `SPEC.md`** — move to `docs/internal/` or delete; replace with a
   real `docs/` tree (see Phase 2).
8. **Resolve package naming** — one decision, applied everywhere:
   - `zehrava-gate` = server + JS SDK (npm, already published) ✓
   - `zehrava-gate-mcp` = MCP server → **publish to npm**
   - `zehrava-gate-langchain` = LangChain wrapper (already published) —
     fix its README, which advertises `@zehrava/langchain-gate`
   - Deprecate `@kaicmo/gate` on npm with a pointer to `zehrava-gate`
   - Delete whichever of `gate-sdk-py` / `gate-sdk-python` is stale
9. **Root `package.json` with npm workspaces** — `npm install && npm test`
   from the repo root runs everything.

## Phase 1 — Five-minute first success

The `npx zehrava-gate demo` path is a great start. Extend it so every
deployment style has a one-liner:

1. **Dockerfile + `docker-compose.yml`** at repo root (server + volume for
   SQLite + policies dir). Publish `ghcr.io/cgallic/zehrava-gate`.
2. **One-click deploy buttons** — Railway, Render, Fly.io templates in the
   README. Gate is a single Node process with SQLite; this is the easiest
   possible service to template.
3. **TypeScript types** — ship `.d.ts` for the SDK (hand-written is fine at
   this size). Agentic builders live in TypeScript; an untyped SDK reads as
   unmaintained.
4. **OpenAPI 3.1 spec** (`schemas/openapi.yaml`) generated from the existing
   route handlers + JSON schemas in `schemas/`. This unlocks generated
   clients in any language and lets agents introspect the API.
5. **`npx zehrava-gate init`** — scaffolds a `policies/` dir with the three
   canonical policies (support-reply, crm-low-risk, finance-high-risk) and
   a `.env`, then prints the quickstart. Reduce "clone the repo to see
   example policies" to one command.

## Phase 2 — Agent-native distribution (the differentiator)

Gate's buyers are agents and the people who build them. The repo should be
legible to both.

1. **`llms.txt` + `llms-full.txt`** on zehrava.com and mirrored in-repo:
   condensed, plain-markdown API + policy reference designed for an agent
   to ingest in one context window. When a builder asks their coding agent
   "add human approval to my agent's writes," the agent should be able to
   find and correctly integrate Gate without a human reading docs.
2. **In-repo `docs/` in markdown** (source of truth; landing HTML becomes a
   build artifact or links here): quickstart, policy reference (every YAML
   field with examples), authority model, approval providers, proxy mode,
   threat model, self-hosting guide.
3. **Publish + register the MCP server**:
   - Publish `zehrava-gate-mcp` to npm (blocker from Phase 0)
   - Submit to the MCP registry and awesome-mcp-servers lists
   - Add a Claude Desktop / Claude Code / Cursor setup snippet for each
     host in `packages/mcp-gate/README.md`
4. **Claude Code plugin: PreToolUse hook** — a `.claude/` plugin that routes
   any matching tool call (Bash writes, MCP writes) through
   `gate.propose()` and blocks on `pending_approval`. This turns every
   Claude Code user into a potential Gate user with zero code changes, and
   it's a genuinely novel demo: "your coding agent's deploys now require
   sign-off."
5. **Cookbook (`examples/` upgrade)** — one runnable recipe per pattern,
   each under 100 lines with a README: idempotency keys, N-of-M quorum,
   standing approvals, webhook consumers, proxy mode, "governed refund
   agent" end-to-end. The current hubspot/zendesk/finance examples fold in
   here.

## Phase 3 — Meet builders on their stack

One integration per major framework, each thin (the LangChain wrapper is
the template: ~1 file wrapping `propose → poll → execute`):

| Integration | Shape | Priority |
|---|---|---|
| OpenAI Agents SDK | tool guardrail wrapper (Python + JS) | High — largest builder pool |
| Vercel AI SDK | `wrapTool()` middleware | High — TS-native, huge reach |
| CrewAI | tool decorator | High — Python agent mainstream |
| Claude Agent SDK | PreToolUse hook (shares code with Phase 2.4) | High — strategic fit with MCP story |
| Pydantic AI | tool wrapper | Medium |
| AutoGen / AG2 | function guard | Medium |
| LlamaIndex | tool wrapper | Medium |
| n8n | community node ("Gate approval" step) | Medium — no-code reach |

Each ships with: a runnable example, a docs page, and a `for/<framework>`
landing page (the `landing/for/` pattern already exists — extend it).

## Phase 4 — Community & ecosystem gravity

1. **Policy pack gallery** — `policies/packs/` with vetted, real-world packs
   (e-commerce refunds, CRM hygiene, outbound comms, finance ops, content
   publishing). Policies are Gate's "themes" — the natural community
   contribution unit. Accept packs via PR with a schema-validation CI check.
2. **Approval provider SDK** — document the provider interface
   (`src/lib/approval-providers/`) as a public extension point; a Slack
   provider and a plain-email provider are the two most-requested channels
   and make great first community projects.
3. **GitHub Discussions + good-first-issue backlog** — seed 10–15 scoped
   issues (new policy fields, provider stubs, framework wrappers) so the
   repo looks alive and contributable.
4. **Benchmarks page** — publish the auto-approve latency figure (<5ms
   claimed in the langchain README) with a reproducible script. "Governance
   without latency" is the objection to preempt.
5. **Comparison content** — the `landing/vs/` pattern exists for Tetrate;
   add honest comparisons vs. HumanLayer, gotoHuman, Permit.io Access
   Request, and plain LangGraph `interrupt()` — these are what builders
   actually evaluate against.

---

## Sequencing

- **Weeks 1–2 (Phase 0 + npm fixes):** LICENSE, CI, CONTRIBUTING, SECURITY,
  CHANGELOG, templates, publish `zehrava-gate-mcp`, deprecate
  `@kaicmo/gate`, delete duplicate Python SDK, root workspaces.
- **Weeks 3–4 (Phase 1):** Docker + deploy buttons, TypeScript types,
  OpenAPI spec, `init` command.
- **Weeks 5–8 (Phase 2):** llms.txt, in-repo docs, MCP registry listings,
  Claude Code PreToolUse plugin, cookbook.
- **Quarter 2 (Phases 3–4):** framework integrations in priority order,
  policy packs, provider SDK, comparisons.

## Success metrics

- Time-to-first-governed-write from a cold clone: **< 5 minutes** (measure
  it; put the number in the README)
- CI green badge on every commit; all published packages installable as
  documented (today `zehrava-gate-mcp` fails this)
- MCP server listed in the official registry; ≥ 3 framework integrations
  live with runnable examples
- First external contributor PR merged (policy pack or provider)
- README quickstart executable top-to-bottom by a coding agent with no
  human intervention — the ultimate test for a repo serving agentic
  builders
