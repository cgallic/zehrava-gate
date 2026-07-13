# Security Policy

Zehrava Gate is a security product — a write-path control plane that agents
and operators trust to be fail-closed. We take vulnerability reports
seriously and appreciate researchers who disclose responsibly.

## Reporting a vulnerability

- **Email:** [connor@kaicalls.com](mailto:connor@kaicalls.com)
- **Do not open public GitHub issues for vulnerabilities.** Public issues
  are fine for ordinary bugs; anything with security impact goes to email
  first.
- Include what you can: affected version/commit, the policy YAML and intent
  payload involved (redacted), reproduction steps, and impact.

**Response target: 72 hours.** You'll get an acknowledgement and an initial
assessment within that window, and we'll keep you updated through the fix
and disclosure. Please give us a reasonable window to ship a fix before
publishing details.

## Scope

Gate's threat model is deliberately honest: **Gate protects against agent
mistakes, not fully adversarial agents.** An agent that simply never calls
the SDK is outside what Gate can enforce (network-level enforcement via the
V3 forward proxy narrows this, but the SDK path is opt-in by design). Within
that model, the guarantees Gate *does* make are exactly what we want tested.

### In scope

- **Policy-engine bypasses** — any input where a policy that should block or
  require approval yields `approved` (term-normalization evasion,
  field-check evasion, rate-limit evasion, environment-override abuse, etc.)
- **Execution-token forgery or replay** — minting, tampering with, replaying,
  or extending `gex_` execution orders without a valid approved intent
- **Signed-callback verification flaws** — bypassing approval-provider
  response verification (e.g. the A2H bridge), spoofing a provider decision,
  or replaying an already-answered/expired approval interaction
- **Authentication/authorization issues on API routes** — acting on another
  agent's intents, approving without authority, escalating via the Layer 2
  authority model (standing approvals, delegation, quorum)
- **Webhook signature bypass** — forging outbound webhook deliveries or
  defeating signature verification on inbound webhook consumers

### Out of scope

- **An agent simply not calling Gate** — bypassing governance by never
  submitting an intent is the documented boundary of the product, not a
  vulnerability
- **Denial of service** — volumetric or resource-exhaustion attacks against
  a self-hosted Gate instance
- **Issues requiring a compromised host** — if an attacker already has the
  server box, the signing keys, the SQLite database, or the environment
  variables, Gate's guarantees are void by definition
- Vulnerabilities in third-party dependencies without a demonstrated impact
  on Gate (report those upstream, though a heads-up is welcome)

If you're unsure whether something is in scope, err on the side of emailing
— worst case we'll tell you it's expected behavior and thank you anyway.
