require('dotenv').config();
const express = require('express');
const db = require('./lib/db');
const { generateId, generateApiKey, hashApiKey } = require('./lib/crypto');
const { logEvent } = require('./lib/audit');
const { listPolicies } = require('./lib/policy');
const { authenticate } = require('./middleware/auth');

const proposalsRouter = require('./routes/proposals');
const subscribeRouter = require('./routes/subscribe');
const approvalsRouter = require('./routes/approvals');
const deliveryRouter = require('./routes/delivery');
const auditRouter = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Make BASE_URL available to delivery routes
process.env.BASE_URL = BASE_URL;

app.use(express.json({ limit: '50mb' }));

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

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'zehrava-gate', version: '0.1.0' });
});

// Agent registration (no auth)
app.post('/v1/agents/register', (req, res) => {
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
app.get('/v1/agents', authenticate, (req, res) => {
  const agents = db.prepare('SELECT id, name, risk_tier, created_at FROM agents').all();
  res.json({ agents });
});

// List policies
app.get('/v1/policies', authenticate, (req, res) => {
  res.json({ policies: listPolicies() });
});

// List proposals by status (for dashboard)
app.get('/v1/proposals', authenticate, (req, res) => {
  const { status, limit = 50 } = req.query;
  let query = 'SELECT p.*, a.name as agent_name FROM proposals p LEFT JOIN agents a ON p.sender_agent_id = a.id';
  const params = [];
  if (status) {
    query += ' WHERE p.status = ?';
    params.push(status);
  }
  query += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  const proposals = db.prepare(query).all(...params).map(p => ({
    ...p,
    created_at: new Date(p.created_at).toISOString(),
    expires_at: p.expires_at ? new Date(p.expires_at).toISOString() : null
  }));
  res.json({ proposals, count: proposals.length });
});

// Mount all routers at /v1
app.use('/v1', proposalsRouter);
app.use('/v1', subscribeRouter);
app.use('/v1', approvalsRouter);
app.use('/v1', deliveryRouter);
app.use('/v1/audit', auditRouter);

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
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT p.*, a.name as agent_name
    FROM proposals p
    LEFT JOIN agents a ON p.sender_agent_id = a.id
    WHERE a.name = 'kai-cmo'
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ proposals: rows.map(scrubProposal), count: rows.length });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`Zehrava Gate running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});

module.exports = app;

