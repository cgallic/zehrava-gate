const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { generateId, generateExecutionToken } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

// POST /v1/intents/:id/execute — issue execution order
router.post('/intents/:id/execute', authenticate, (req, res) => {
  const intent = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!intent) return res.status(404).json({ error: 'Intent not found' });

  // Check expiry
  if (intent.expires_at && Date.now() > intent.expires_at) {
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('expired', intent.id);
    return res.status(410).json({ error: 'Intent expired', status: 'expired' });
  }

  if (intent.status !== 'approved') {
    return res.status(409).json({
      error: `Intent cannot be executed — current status: ${intent.status}`,
      status: intent.status,
      hint: intent.status === 'pending_approval' ? 'Approve the intent first at /v1/intents/:id/approve' : undefined
    });
  }

  // Check if execution already exists
  const existing = db.prepare('SELECT * FROM executions WHERE intent_id = ?').get(intent.id);
  if (existing && existing.status === 'scheduled') {
    return res.json(formatExecution(existing));
  }
  if (existing && ['executing','succeeded'].includes(existing.status)) {
    return res.status(409).json({ error: `Execution already ${existing.status}`, execution_id: existing.id, status: existing.status });
  }

  const mode = req.body.mode || 'runner_exec';
  const executionId = generateId('exe');
  const executionToken = generateExecutionToken();
  const now = Date.now();
  const expiresAt = now + (15 * 60 * 1000); // 15 min

  db.prepare(`
    INSERT INTO executions (id, intent_id, mode, destination, action, payload_ref, payload_hash, execution_token, status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `).run(
    executionId, intent.id, mode,
    intent.destination,
    intent.action || intent.destination,
    intent.payload_path || null,
    intent.payload_hash || null,
    executionToken,
    now, expiresAt
  );

  // Update intent status to scheduled
  db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('scheduled', intent.id);
  logEvent(intent.id, 'execution_requested', req.agent?.name || 'system', { executionId, mode });

  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId);
  res.status(201).json(formatExecution(execution));
});

// GET /v1/executions/:id
router.get('/executions/:id', authenticate, (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });
  res.json(formatExecution(execution));
});

// POST /v1/executions/:id/report — worker reports result
// Worker auth: Bearer <execution_token>
router.post('/executions/:id/report', (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });

  // Auth: execution_token or standard API key
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const isValidToken = token === execution.execution_token;

  // Also accept standard API key auth
  let isValidApiKey = false;
  if (!isValidToken) {
    const agent = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?')
      .get(require('../lib/crypto').hashApiKey(token));
    isValidApiKey = !!agent;
  }

  if (!isValidToken && !isValidApiKey) {
    return res.status(401).json({ error: 'Invalid execution token or API key' });
  }

  // Check token expiry
  if (execution.expires_at && Date.now() > execution.expires_at && execution.status === 'scheduled') {
    db.prepare('UPDATE executions SET status = ? WHERE id = ?').run('expired', execution.id);
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('failed', execution.intent_id);
    return res.status(410).json({ error: 'Execution token expired' });
  }

  const { status, result, executed_at } = req.body;
  if (!['succeeded', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be succeeded or failed' });
  }

  const executedAt = executed_at ? new Date(executed_at).getTime() : Date.now();
  db.prepare(`
    UPDATE executions SET status = ?, executed_at = ?, result = ? WHERE id = ?
  `).run(status, executedAt, result ? JSON.stringify(result) : null, execution.id);

  const intentStatus = status === 'succeeded' ? 'succeeded' : 'failed';
  db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(intentStatus, execution.intent_id);

  const eventType = status === 'succeeded' ? 'execution_succeeded' : 'execution_failed';
  logEvent(execution.intent_id, eventType, 'runner', { executionId: execution.id, result });

  const updated = db.prepare('SELECT * FROM executions WHERE id = ?').get(execution.id);
  res.json(formatExecution(updated));
});

function formatExecution(e) {
  return {
    executionId: e.id,
    execution_id: e.id,
    intent_id: e.intent_id,
    mode: e.mode,
    destination: e.destination,
    action: e.action,
    payload_ref: e.payload_ref,
    payload_hash: e.payload_hash,
    execution_token: e.execution_token,
    retry_policy: e.retry_policy ? JSON.parse(e.retry_policy) : { max_attempts: 3, backoff_seconds: 30 },
    status: e.status,
    issued_at: new Date(e.issued_at).toISOString(),
    expires_at: new Date(e.expires_at).toISOString(),
    executed_at: e.executed_at ? new Date(e.executed_at).toISOString() : null,
    result: e.result ? JSON.parse(e.result) : null
  };
}

module.exports = router;
