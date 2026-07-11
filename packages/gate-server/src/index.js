require('dotenv').config();
const express = require('express');
const db = require('./lib/db');
const { generateId, generateApiKey, hashApiKey } = require('./lib/crypto');
const { logEvent } = require('./lib/audit');
const { listPolicies } = require('./lib/policy');
const { authenticate } = require('./middleware/auth');

const proposalsRouter = require('./routes/proposals');
const agentsRouter = require('./routes/agents');
const executionsRouter = require('./routes/executions');
const subscribeRouter = require('./routes/subscribe');
const approvalsRouter = require('./routes/approvals');
const deliveryRouter = require('./routes/delivery');
const auditRouter = require('./routes/audit');
const runsRouter = require('./routes/runs');

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Make BASE_URL available to delivery routes
process.env.BASE_URL = BASE_URL;

// Capture the raw request body alongside express's parsed JSON so signed
// callback routes (issue #14) can verify an HMAC over the exact bytes that
// were sent, not a re-serialization of the parsed object (which could
// differ in key order/whitespace and break signature verification).
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// CORS — public feed open to all origins, rest locked to same-origin
app.use((req, res, next) => {
  if (req.path === '/v1/public/feed' || req.path === '/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// GET /.well-known/gate — capability discovery, derived from real server
// config/policy features so agents/SDKs can adapt instead of guessing.
function buildCapabilities() {
  const { listPolicies, getPolicyFeatures, getConfiguredApprovalProviders } = require('./lib/policy');
  const { DEFAULT_NONCE_TTL_SEC, DEFAULT_TIMESTAMP_TOLERANCE_SEC } = require('./lib/replay');
  const { getProviderCapabilities } = require('./lib/approval-providers');
  const providers = getConfiguredApprovalProviders();
  const providerCapabilities = Object.fromEntries(providers.map((p) => [p, getProviderCapabilities(p)]));
  return {
    gate_supported: ['1.0'],
    auth: { methods: ['api_key'] },
    approval_channels: ['webhook', 'approval_link', ...providers],
    approval_providers: providers,
    approval_provider_capabilities: providerCapabilities,
    evidence_factors: ['manual.dashboard.v1', 'link.single_use.v1'],
    max_execution_ttl_sec: 900,
    replay_protection: {
      idempotency_window_sec: null,
      timestamp_tolerance_sec: DEFAULT_TIMESTAMP_TOLERANCE_SEC,
      nonce_endpoint: '/v1/nonce',
      nonce_ttl_sec: DEFAULT_NONCE_TTL_SEC,
      single_use_approval_links: true,
    },
    webhooks: { supported: true, retry_attempts: 1, timeout_sec: 30 },
    approval_callback_endpoint: '/v1/approval-callbacks/:provider',
    policy_features: getPolicyFeatures(),
    policies_available: listPolicies().length,
  };
}

app.get('/.well-known/gate', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(buildCapabilities());
});

// Optional A2H-compatible alias — same capabilities, A2H-flavored field names.
if (process.env.GATE_A2H_COMPAT === 'true') {
  app.get('/.well-known/a2h', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const caps = buildCapabilities();
    res.json({
      a2h_supported: caps.gate_supported,
      auth: caps.auth,
      channels: caps.approval_channels,
      evidence_factors: caps.evidence_factors,
      max_ttl_sec: caps.max_execution_ttl_sec,
      replay_protection: caps.replay_protection,
      webhooks: caps.webhooks,
    });
  });
}

// GET /v1/nonce — single-use challenge for approval channels that need one
// (e.g. an external A2H-style provider proving a response isn't replayed).
app.get('/v1/nonce', authenticate, (req, res) => {
  const { issueNonce } = require('./lib/replay');
  const { nonce, expiresAt } = issueNonce();
  res.json({ nonce, expiresAt: new Date(expiresAt).toISOString() });
});

// Health
app.get('/health', (req, res) => {
  const proxyEnabled = !!process.env.PROXY_API_KEY;
  const tlsIntercept = process.env.GATE_TLS_INTERCEPT === 'true';
  res.json({
    status: 'ok',
    service: 'zehrava-gate',
    version: '0.3.0',
    proxy: proxyEnabled ? { enabled: true, port: process.env.PROXY_PORT || 4001, tls_intercept: tlsIntercept } : { enabled: false },
  });
});

// GET /v1/proxy/ca.crt — download Gate's CA certificate for agent trust
app.get('/v1/proxy/ca.crt', (req, res) => {
  if (!process.env.PROXY_API_KEY) {
    return res.status(404).json({ error: 'Proxy not enabled' });
  }
  const { getCAPath } = require('./proxy/ca');
  const caPath = getCAPath();
  const fs = require('fs');
  if (!fs.existsSync(caPath)) {
    return res.status(404).json({ error: 'CA not initialized yet — server may still be starting' });
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="gate-ca.crt"');
  res.sendFile(caPath);
});

// GET /v1/proxy/held — list held connections (auth required)
app.get('/v1/proxy/held', authenticate, (req, res) => {
  if (!process.env.PROXY_API_KEY) {
    return res.status(404).json({ error: 'Proxy not enabled' });
  }
  const holdQueue = require('./proxy/hold-queue');
  res.json({ held: holdQueue.list(), count: holdQueue.size() });
});

// Legacy agent endpoints now handled by agentsRouter
// (keeping this comment for backward compat)
app.post('/v1/agents/register_DISABLED', (req, res) => {
  const { name, riskTier } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const agentId = generateId('agt');
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const now = Date.now();

  db.prepare(`
    INSERT INTO agents (id, name, api_key_hash, risk_tier, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, name, keyHash, riskTier || 'standard', now);

  logEvent(null, 'agent_registered', name, { agentId, riskTier: riskTier || 'standard' });

  res.json({ agentId, apiKey, name, riskTier: riskTier || 'standard' });
});

// List agents
// /v1/agents handled by agentsRouter below

// List policies
app.get('/v1/policies', authenticate, (req, res) => {
  res.json({ policies: listPolicies() });
});

// Strip single-use approval link tokens out of bulk/listing responses —
// they're only disclosed once, in the propose response, same as a delivery link.
function redactProposal(p) {
  const { approval_link_token, ...rest } = p;
  return { ...rest, has_approval_link: !!approval_link_token };
}

// List proposals by status (for dashboard)
app.get('/v1/proposals', authenticate, (req, res) => {
  const { status, limit = 50 } = req.query;
  const isReviewer = (req.agent?.role === 'admin' || req.agent?.role === 'reviewer');

  let query = 'SELECT p.*, a.name as agent_name FROM proposals p LEFT JOIN agents a ON p.sender_agent_id = a.id';
  const params = [];

  const where = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (!isReviewer) { where.push('p.sender_agent_id = ?'); params.push(req.agent.id); }

  if (where.length) query += ' WHERE ' + where.join(' AND ');

  query += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const proposals = db.prepare(query).all(...params).map(p => ({
    ...redactProposal(p),
    created_at: new Date(p.created_at).toISOString(),
    expires_at: p.expires_at ? new Date(p.expires_at).toISOString() : null
  }));
  res.json({ proposals, count: proposals.length });
});

// Mount all routers at /v1
app.use('/v1', agentsRouter);
app.use('/v1', executionsRouter);
app.use('/v1', proposalsRouter);

// V2 API: /v1/intents aliases for spec-compliant clients
app.post('/v1/intents', (req, res, next) => {
  // Map V2 intent fields to V1 proposal fields
  if (req.body.action && !req.body.destination) req.body.destination = req.body.action;
  if (req.body.policy_id && !req.body.policy) req.body.policy = req.body.policy_id;
  if (req.body.estimated_records && !req.body.recordCount) req.body.recordCount = req.body.estimated_records;
  next();
}, (req, res, next) => { req.url = '/propose'; next(); }, proposalsRouter);

app.post('/v1/intents/:id/approve', (req, res, next) => { req.body.proposalId = req.params.id; next(); }, (req, res, next) => { req.url = '/approve'; next(); }, require('./routes/approvals'));
app.post('/v1/intents/:id/reject', (req, res, next) => { req.body.proposalId = req.params.id; next(); }, (req, res, next) => { req.url = '/reject'; next(); }, require('./routes/approvals'));
app.get('/v1/intents', authenticate, (req, res) => {
  const { status, limit = 50 } = req.query;
  const isReviewer = (req.agent?.role === 'admin' || req.agent?.role === 'reviewer');

  let query = 'SELECT p.*, a.name as agent_name FROM proposals p LEFT JOIN agents a ON p.sender_agent_id = a.id';
  const params = [];

  const where = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (!isReviewer) { where.push('p.sender_agent_id = ?'); params.push(req.agent.id); }

  if (where.length) query += ' WHERE ' + where.join(' AND ');

  query += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const intents = db.prepare(query).all(...params).map(p => ({
    ...redactProposal(p), intentId: p.id,
    created_at: new Date(p.created_at).toISOString(),
    expires_at: p.expires_at ? new Date(p.expires_at).toISOString() : null
  }));
  res.json({ intents, count: intents.length });
});
app.get('/v1/intents/:id', (req, res, next) => { req.url = `/proposals/${req.params.id}`; next(); }, proposalsRouter);
app.get('/v1/intents/:id/audit', (req, res, next) => { req.url = `/${req.params.id}`; next(); }, require('./routes/audit'));
app.get('/v1/intents/:id/decision', authenticate, (req, res) => {
  const d = db.prepare('SELECT * FROM policy_decisions WHERE intent_id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No decision found for this intent' });
  const { getApprovalEvidence } = require('./lib/evidence');
  res.json({ ...d, evaluated_at: new Date(d.evaluated_at).toISOString(), approval_evidence: getApprovalEvidence(req.params.id) });
});
app.use('/v1', subscribeRouter);
app.use('/v1', approvalsRouter);
app.use('/v1', deliveryRouter);
app.use('/v1/audit', auditRouter);

// Internal API for Run Ledger
runsRouter(app);

// ── PUBLIC READ-ONLY FEED ─────────────────────────────────────────
function scrubPii(text) {
  if (!text) return '';
  text = text.replace(/[a-zA-Z0-9._%+\-]+@([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g, '****@$1');
  text = text.replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, '***-***-****');
  return text;
}

function scrubProposal(p) {
  return {
    id: p.id,
    agent: p.agent_name || 'agent',
    destination: p.destination,
    policy: p.policy_id,
    status: p.status,
    record_count: p.record_count || null,
    block_reason: p.block_reason ? scrubPii(p.block_reason) : null,
    created_at: p.created_at,
    payload_hint: p.payload_path
      ? (p.payload_path.startsWith('{') ? '[email payload]' : p.payload_path.split('/').pop().split('?')[0])
      : null
  };
}

app.get('/v1/public/feed', (req, res) => {
  if (process.env.PUBLIC_FEED_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const allowName = (process.env.PUBLIC_FEED_AGENT_NAME || 'demo-agent').trim();

  const rows = db.prepare(`
    SELECT p.*, a.name as agent_name
    FROM proposals p
    LEFT JOIN agents a ON p.sender_agent_id = a.id
    WHERE a.name = ?
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(allowName, limit);

  res.json({ proposals: rows.map(scrubProposal), count: rows.length, agent: allowName });
});

// GET /v1/metrics
app.get('/v1/metrics', authenticate, (req, res) => {
  const s = (q) => db.prepare(q).get();
  const total   = s("SELECT COUNT(*) as n FROM proposals").n;
  const blocked = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'blocked'").n;
  const pending = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'pending_approval'").n;
  const approved = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'approved'").n;
  const scheduled = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'scheduled'").n;
  const succeeded = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'succeeded'").n;
  const failed  = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'failed'").n;
  const dupes   = s("SELECT COUNT(*) as n FROM proposals WHERE status = 'duplicate_blocked'").n;
  const latency = db.prepare("SELECT AVG(approved_at - created_at) as avg FROM proposals WHERE approved_at IS NOT NULL AND created_at IS NOT NULL").get();
  res.json({
    actions_attempted: total,
    actions_blocked: blocked,
    actions_pending: pending,
    actions_approved: approved,
    actions_scheduled: scheduled,
    actions_succeeded: succeeded,
    actions_failed: failed,
    duplicate_actions: dupes,
    policy_violations: blocked,
    avg_approval_latency_ms: latency?.avg ? Math.round(latency.avg) : null,
    period: 'all_time'
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`Zehrava Gate running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);

  // Start V3 proxy if PROXY_API_KEY is set
  if (process.env.PROXY_API_KEY) {
    // Initialize CA for TLS intercept (generates once, loads on subsequent starts)
    const { initCA, getCAPath } = require('./proxy/ca');
    initCA();
    const { startProxy } = require('./proxy/engine');
    startProxy();
  } else {
    console.log('[gate] Proxy disabled — set PROXY_API_KEY to enable forward proxy on port 4001');
  }
});

module.exports = app;

