# Zehrava Gate — Full Build Spec

> PRD is the source of truth. This spec translates it into concrete deliverables.
> Server is live at https://zehrava.com. API running on port 3001.

---

## What's already built

- ✅ Gate server (Express + SQLite) — `/opt/zehrava-gate/`
- ✅ Policy engine — 5 YAML policies in `/opt/zehrava-gate/policies/`
- ✅ JS SDK (`@zehrava/gate`) — `/root/repos/zehrava-gate/packages/gate-sdk-js/`
- ✅ Python SDK (`zehrava_gate`)
- ✅ Integration test — 13/13 passing
- ✅ Landing page — https://zehrava.com

---

## What needs to be built

### 1. Approval Queue Dashboard (`/dashboard`)

**URL:** https://zehrava.com/dashboard  
**Files:** `/var/www/bus/dashboard/index.html` (static HTML/JS — talks directly to the Gate API)

**What it shows:**
- Pending proposals (status = pending_approval)
- Each row: proposalId, sender agent, destination, policy, record count, created_at, expires_at
- Action buttons: **Approve** (green) / **Reject** (red)
- Completed tab: delivered + blocked proposals with full audit trail
- Auto-refresh every 10 seconds

**API calls it makes:**
```
GET /v1/proposals?status=pending_approval  ← need to add this endpoint
POST /v1/approve { proposalId }
POST /v1/reject { proposalId, reason }
GET /v1/audit/:proposalId
```

**Design:** Match zehrava.com dark theme — same CSS variables, Inter font, purple accent.

**Auth:** For v1, use a hardcoded demo API key (env var: `DASHBOARD_API_KEY`). Show it on the page so demo users can use it.

---

### 2. Live Interactive Demo Page (`/demo`)

**URL:** https://zehrava.com/demo  
**Files:** `/var/www/bus/demo/index.html`

This is the KILLER DEMO from the PRD. Three scenarios, all running against the real live API.

**Design:** Split screen — left panel shows the "agent code" running, right panel shows Gate's response in real time.

**Scenario A — CRM Bulk Update (pending_approval)**
```
Agent proposes: 847 leads → salesforce.import (crm-low-risk)
Gate: sender verified → destination ✓ → record count 847 > 100 → pending_approval
User clicks "Approve" → delivered → audit logged
```

**Scenario B — Finance payout (blocked)**
```
Agent proposes: payout.csv → unknown.system (finance-high-risk)  
Gate: destination not in allowlist → blocked immediately
Show: blockReason, full audit trail
```

**Scenario C — Support reply (auto-approved + blocked)**
```
Safe reply: auto-approved, delivered instantly
Risky reply with "refund guaranteed": blocked by term scan
Show side-by-side
```

**UX flow:**
1. Page loads with 3 scenario tabs
2. User clicks "Run" on a scenario
3. Animated terminal shows the `gate.propose()` call being made (typewriter effect)
4. Status badge animates: pending → approved/blocked
5. For pending: "Approve" button appears, links to /dashboard
6. Shows full audit trail below

**Implementation:**
- All API calls go to `/v1/` on same domain (proxied to port 3001)
- Register a demo agent on page load (or use a pre-registered demo key)
- Use `fetch()` — no framework needed

---

### 3. New API endpoint: List proposals by status

Add to gate server:

```
GET /v1/proposals?status=pending_approval&limit=20
→ { proposals: [...] }

GET /v1/proposals?status=delivered&limit=20
GET /v1/proposals?status=blocked&limit=20
```

Also needed for dashboard:
```
GET /v1/proposals/:id  ← already exists
POST /v1/approve  ← already exists  
POST /v1/reject   ← already exists
```

---

### 4. Update example scripts to run against live API

Files in `/root/repos/zehrava-gate/examples/`:
- `hubspot-gate/index.js`
- `finance-gate/index.js`  
- `zendesk-gate/index.js`

These currently hardcode `http://localhost:3001`. Update to:
- Default to `https://zehrava.com` if `GATE_URL` not set
- Register a fresh demo agent on each run
- Print clean colored output (no raw JSON dumps)
- End with: "✓ View full audit trail at: https://zehrava.com/dashboard"

---

### 5. Add nav links to landing page

Add to `/var/www/bus/index.html` nav:
- "Dashboard" → `/dashboard`
- "Live Demo" → `/demo` (highlighted in purple)

---

### 6. Caddy route for /dashboard and /demo

Add to `/etc/caddy/Caddyfile` under `zehrava.com`:
```
handle /dashboard* {
    root * /var/www/bus
    file_server
}
handle /demo* {
    root * /var/www/bus  
    file_server
}
```
(Already covered by the catch-all `handle` block — just need the HTML files in `/var/www/bus/`)

---

## Build order

1. Add `GET /v1/proposals` list endpoint to gate server
2. Build `/var/www/bus/dashboard/index.html`
3. Build `/var/www/bus/demo/index.html`
4. Update example scripts
5. Update main nav
6. Restart PM2, test end-to-end

---

## Acceptance criteria

- [ ] Dashboard shows pending proposals and allows approve/reject in one click
- [ ] Demo page runs all 3 scenarios against live API
- [ ] Scenario A: pending_approval → user approves → status changes live on page
- [ ] Scenario B: blocked immediately with reason shown
- [ ] Scenario C: safe auto-approved, risky blocked with term shown
- [ ] Examples run with `GATE_URL=https://zehrava.com node examples/hubspot-gate/index.js`
- [ ] Everything matches zehrava.com dark theme
- [ ] Mobile responsive

---

## Server details

- Gate API: `http://localhost:3001` (PM2: `zehrava-gate`)
- Static files: `/var/www/bus/`
- API key for dashboard: register a new agent, hardcode key in dashboard HTML for demo purposes
- Policies dir: `/opt/zehrava-gate/policies/`
- Data dir: `/opt/zehrava-gate/data/`
