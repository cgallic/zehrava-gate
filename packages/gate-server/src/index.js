require('dotenv').config();
const express = require('express');
const db = require('./lib/db');
const { generateId, generateApiKey, hashApiKey } = require('./lib/crypto');
const { logEvent } = require('./lib/audit');
const { listPolicies } = require('./lib/policy');
const { authenticate } = require('./middleware/auth');

const proposalsRouter = require('./routes/proposals');
const approvalsRouter = require('./routes/approvals');
const deliveryRouter = require('./routes/delivery');
const auditRouter = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Make BASE_URL available to delivery routes
process.env.BASE_URL = BASE_URL;

app.use(express.json({ limit: '50mb' }));

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

// Mount all routers at /v1
app.use('/v1', proposalsRouter);
app.use('/v1', approvalsRouter);
app.use('/v1', deliveryRouter);
app.use('/v1/audit', auditRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`Zehrava Gate running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});

module.exports = app;
