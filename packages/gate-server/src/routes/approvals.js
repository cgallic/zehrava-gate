const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const db = require('../lib/db');
const { generateId, generateDeliveryToken } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

// Auto-delivery destinations — approve triggers immediate deliver
const AUTO_DELIVER_DESTINATIONS = ['blog.publish', 'gmail.send', 'loops.send'];

function autoDeliver(proposalId, destination, deliveryToken) {
  // Fire-and-forget: call the Python delivery worker
  execFile('python3', [
    '/opt/cmo-analytics/gate_delivery_worker.py'
  ], { env: { ...process.env } }, (err, stdout, stderr) => {
    if (err) console.error(`[gate] auto-deliver failed for ${proposalId}:`, err.message);
    else console.log(`[gate] auto-delivered ${proposalId} → ${destination}`);
  });
}

// POST /v1/approve
router.post('/approve', authenticate, (req, res) => {
  const { proposalId } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (proposal.status === 'blocked') {
    return res.status(409).json({ error: 'Cannot approve a blocked proposal' });
  }
  if (proposal.status === 'delivered') {
    return res.status(409).json({ error: 'Proposal already delivered' });
  }
  if (proposal.status === 'approved') {
    // Already approved — return existing manifest token
    const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(proposalId);
    return res.json({ status: 'approved', approvedAt: new Date().toISOString(), intentId: proposalId, deliveryToken: manifest?.delivery_token });
  }

  // Check expiry
  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposalId);
    logEvent(proposalId, 'expired', 'system', {});
    return res.status(410).json({ error: 'Proposal has expired' });
  }

  const deliveryToken = generateDeliveryToken();

  // Update proposal status
  db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);

  // Create manifest
  db.prepare(`
    INSERT INTO manifests (id, proposal_id, signed_by, delivery_token)
    VALUES (?, ?, ?, ?)
  `).run(generateId('mfst'), proposalId, req.agent.name, deliveryToken);

  logEvent(proposalId, 'approved', req.agent.name, { approver: req.agent.name });
  fireWebhook(proposalId, 'approved', { approver: req.agent.name });

  // Auto-deliver for configured destinations
  if (AUTO_DELIVER_DESTINATIONS.includes(proposal.destination)) {
    autoDeliver(proposalId, proposal.destination, deliveryToken);
  }

  res.json({ status: 'approved', approvedAt: new Date().toISOString(), intentId: proposalId, deliveryToken, autoDeliver: AUTO_DELIVER_DESTINATIONS.includes(proposal.destination) });
});

// POST /v1/reject
router.post('/reject', authenticate, (req, res) => {
  const { proposalId, reason } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (['blocked', 'delivered', 'expired'].includes(proposal.status)) {
    return res.status(409).json({ error: `Cannot reject proposal with status: ${proposal.status}` });
  }

  db.prepare("UPDATE proposals SET status = 'blocked', block_reason = ? WHERE id = ?")
    .run(reason || 'Rejected by reviewer', proposalId);

  logEvent(proposalId, 'rejected', req.agent.name, { reason, rejector: req.agent.name });
  fireWebhook(proposalId, 'rejected', { reason });

  res.json({ status: 'blocked', reason });
});

module.exports = router;

// ── WEBHOOK REGISTRATION ─────────────────────────────────────────
const webhooks = new Map(); // proposalId → { url, secret }

function registerWebhook(proposalId, url, secret) {
  webhooks.set(proposalId, { url, secret });
}

async function fireWebhook(proposalId, event, data) {
  const hook = webhooks.get(proposalId);
  if (!hook) return;
  try {
    const payload = JSON.stringify({ intentId: proposalId, event, ...data, firedAt: new Date().toISOString() });
    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const { URL } = await import('url');
    const u = new URL(hook.url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        ...(hook.secret ? { 'X-Gate-Secret': hook.secret } : {}) }
    });
    req.write(payload);
    req.end();
    webhooks.delete(proposalId); // fire once
    console.log(`[gate] webhook fired: ${proposalId} → ${event}`);
  } catch (e) {
    console.error(`[gate] webhook failed for ${proposalId}:`, e.message);
  }
}

// POST /v1/webhooks/register — register a callback URL for a proposal
router.post('/webhooks/register', authenticate, (req, res) => {
  const intentId = req.body.intentId || req.body.proposalId;
  const { url, secret } = req.body;
  if (!intentId || !url) return res.status(400).json({ error: 'intentId (or proposalId) and url are required' });
  const proposal = db.prepare('SELECT id FROM proposals WHERE id = ?').get(intentId);
  if (!proposal) return res.status(404).json({ error: 'Intent not found' });
  registerWebhook(intentId, url, secret);
  res.json({ registered: true, intentId, url });
});

module.exports.registerWebhook = registerWebhook;
module.exports.fireWebhook = fireWebhook;
