const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateApiKey, hashApiKey } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

// POST /v1/agents/register — no auth required
router.post('/agents/register', (req, res) => {
  const { name, owner, allowed_policies, allowed_destinations, framework, metadata, riskTier } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const agentId = generateId('agt');
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const now = Date.now();

  db.prepare(`
    INSERT INTO agents (id, name, api_key_hash, risk_tier, created_at, owner, allowed_policies, allowed_destinations, status, framework, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    agentId, name, keyHash,
    riskTier || 'standard',
    now,
    owner || null,
    JSON.stringify(allowed_policies || []),
    JSON.stringify(allowed_destinations || []),
    framework || null,
    JSON.stringify(metadata || {})
  );

  logEvent(null, 'agent_registered', name, { agentId, owner, framework });

  res.status(201).json({
    agent_id: agentId,
    agentId,           // V1 compat
    name,
    owner: owner || null,
    framework: framework || null,
    allowed_policies: allowed_policies || [],
    allowed_destinations: allowed_destinations || [],
    status: 'active',
    created_at: new Date(now).toISOString(),
    apiKey   // only returned on registration
  });
});

// GET /v1/agents — list (auth required)
router.get('/agents', authenticate, (req, res) => {
  const agents = db.prepare('SELECT id, name, owner, risk_tier, status, framework, allowed_policies, allowed_destinations, created_at FROM agents').all();
  res.json({
    agents: agents.map(a => ({
      ...a,
      allowed_policies: tryParse(a.allowed_policies, []),
      allowed_destinations: tryParse(a.allowed_destinations, []),
      created_at: new Date(a.created_at).toISOString()
    }))
  });
});

// GET /v1/agents/:id
router.get('/agents/:id', authenticate, (req, res) => {
  const a = db.prepare('SELECT id, name, owner, risk_tier, status, framework, allowed_policies, allowed_destinations, metadata, created_at FROM agents WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agent not found' });
  res.json({
    ...a,
    allowed_policies: tryParse(a.allowed_policies, []),
    allowed_destinations: tryParse(a.allowed_destinations, []),
    metadata: tryParse(a.metadata, {}),
    created_at: new Date(a.created_at).toISOString()
  });
});

// POST /v1/agents/:id/revoke
router.post('/agents/:id/revoke', authenticate, (req, res) => {
  const a = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agent not found' });
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('revoked', req.params.id);
  logEvent(null, 'agent_revoked', req.agent?.name || 'system', { agentId: req.params.id });
  res.json({ agent_id: req.params.id, status: 'revoked' });
});

// POST /v1/agents/:id/suspend
router.post('/agents/:id/suspend', authenticate, (req, res) => {
  const a = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agent not found' });
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('suspended', req.params.id);
  logEvent(null, 'agent_suspended', req.agent?.name || 'system', { agentId: req.params.id });
  res.json({ agent_id: req.params.id, status: 'suspended' });
});

function tryParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

module.exports = router;
