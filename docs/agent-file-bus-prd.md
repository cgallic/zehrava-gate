# Agent File Bus — PRD
**Secure file exchange for distributed AI agents**
*Version 0.1 | March 2026*

---

## Problem

AI agents running on different servers, clouds, or orgs have no standard way to exchange files securely. Current workarounds: shared S3 credentials (security nightmare), SSH hops (not scalable), Discord/Slack messages (visible, not encrypted). As multi-agent systems grow, this becomes a liability.

---

## Solution

A network-native secure file transfer layer for agents. Any agent with an identity key can put, get, and share files — regardless of where it's running. No shared credentials. No SSH. Full audit trail.

**Core loop:**
`Agent A uploads → encrypted + signed → stored → Agent B gets access token → downloads + decrypts`

---

## Deployment Models

### 1. Cloud (Managed)
- Fastest onboarding
- We host API, storage, KMS, audit log
- Best for: small teams, fast pilots
- Pricing: metered on storage + transfer

### 2. Self-Hosted
- Customer runs full stack in their VPC or on-prem
- Docker Compose or Helm chart
- Full data sovereignty — nothing leaves their infra
- Best for: legal, health, finance, enterprise
- `docker run -p 8080:8080 agentfilebus/server`

### 3. Hybrid
- Data plane: customer's own object store (their S3/R2/MinIO)
- Control plane: our managed API (policy, identity, audit)
- Best for: enterprises who need data residency but not full self-host ops burden

---

## Open Source Strategy

### Open source (MIT):
- SDKs (TypeScript, Python, Go)
- Event schema + manifest format
- MCP server implementation
- Local single-node server (self-host core)
- Dashboard core

### Proprietary (commercial):
- Advanced policy engine (ABAC, complex ACLs)
- Enterprise compliance exports (HIPAA/SOC2 reports)
- Multi-region replication
- SSO/SAML
- SLA + support

Developer adoption via OSS → enterprise conversion via proprietary features. Same playbook as MinIO, Vault, GitLab.

---

## Technical Architecture

```
Agent A (Server X)
  → MCP files.put(path, recipients[])
  → Agent File Bus API
      ├── Auth: verify agent identity (keypair)
      ├── Policy: check ACL rules
      ├── KMS: generate envelope key, wrap per-recipient
      ├── Store: encrypted blob → object store (S3/R2/MinIO)
      ├── DB: manifest + grants + metadata
      └── Audit: append-only event log
  → Agent B (Server Y)
      ← MCP files.get(file_id)
      ← Short-lived signed access token
      ← Decrypt with own private key
```

## MCP API Surface

```
files.put(path_or_bytes, metadata, recipients[])  → file_id
files.get(file_id)                                → bytes + manifest
files.share(file_id, recipients[], ttl)           → share_id
files.list(filter)                                → file[]
files.revoke(share_id)                            → ok
files.audit(file_id | agent_id | time_range)      → events[]
```

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Identity | Per-agent keypair (Ed25519) |
| File encryption | Envelope encryption (AES-256-GCM + key wrapped per recipient) |
| Transfer | TLS + short-lived pre-signed URLs (15min TTL) |
| Access control | Grant-based (explicit recipient list, no ambient access) |
| Audit | Append-only log, content-addressed (tamper-evident) |
| Revocation | Grant revocation invalidates all future downloads |

---

## MVP (Week 1)

**Goal:** Two agents on different servers exchange an encrypted file. Zero shared credentials.

**Day 1–2:** Agent identity service (keypair registration, JWT issuance)
**Day 3:** File upload + envelope encryption + object store write
**Day 4:** Grant system + signed download URL generation
**Day 5:** MCP server (files.put, files.get, files.share)
**Day 6:** Basic audit log + CLI tool
**Day 7:** Demo: Kai-CMO → SnappedAI file transfer. End-to-end working.

---

## Business Model

| Tier | Price | Target |
|------|-------|--------|
| OSS / Self-hosted | Free | Indie devs, hobbyists |
| Cloud Starter | $49/mo | Small teams, 10GB storage, 1K transfers/mo |
| Cloud Growth | $199/mo | Agencies, 100GB, 10K transfers, SLA reports |
| Enterprise | Custom | Self-host support, HIPAA, SSO, audit exports |

---

## ICP

**Primary:** AI automation agencies serving regulated clients (legal, health, finance) — they *cannot* use shared credentials, compliance requires auditability

**Secondary:** Multi-agent operators (MDI, OpenClaw setups) — run agents across servers, need secure handoff

**Tertiary:** SaaS teams with embedded agents — need audit trail for SOC2

---

## Risks

| Risk | Mitigation |
|------|------------|
| "Just use S3 presigned URLs" objection | Answer: MCP-native, per-agent identity, no credential sharing, audit trail. S3 requires shared AWS account. |
| Cloud incumbents bundle it | Go deep on agent-native UX + open source trust |
| Crypto complexity scares devs | SDK abstracts all of it. Dev sees: `files.put(path, ['agent-b'])`. Done. |
| Self-host support burden | Managed cloud default. Self-host is advanced tier. |

---

## Name Options (working name: Agent File Bus)
- **Relay** — passes things between agents
- **Courier** — delivers files
- **Conduit** — secure channel
- **Lockbox** — secure storage with access control

Pick one. Ship it.

---

*Repo: github.com/cgallic/agent-sentinel (to be renamed)*
*Next: Day 1 build checklist, SDK scaffold, identity service*
