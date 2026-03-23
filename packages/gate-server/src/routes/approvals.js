const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const db = require('../lib/db');
const { generateId, generateDeliveryToken } = require('../lib/crypto');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');
const { RunLedger } = require('../lib/runs');
const { EVENT_TYPES } = require('../lib/runs/constants');

// Auto-delivery destinations — approve triggers immediate deliver
const AUTO_DELIVER_DESTINATIONS = ['blog.publish', 'gmail.send', 'loops.send'];

function autoDeliver(proposalId, destination, deliveryToken) {
  execFile('python3', [
    '/opt/cmo-analytics/gate_delivery_worker.py'
  ], { env: { ...process.env } }, (err, stdout, stderr) => {
    if (err) console.error(`[gate] auto-deliver failed for ${proposalId}:`, err.message);
    else console.log(`[gate] auto-delivered ${proposalId} → ${destination}`);
  });
}

// ── WEBHOOK SYSTEM (DB-backed, survives restarts) ─────────────────────────

function registerWebhook(intentId, url, secret) {
  const existing = db.prepare('SELECT id FROM webhooks WHERE intent_id = ? AND fired = 0').get(intentId);
  if (existing) {
    // Update URL/secret if re-registered
    db.prepare('UPDATE webhooks SET url = ?, secret = ? WHERE id = ?')
      .run(url, secret || null, existing.id);
    return existing.id;
  }
  const id = generateId('whk');
  db.prepare('INSERT INTO webhooks (id, intent_id, url, secret, fired, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, intentId, url, secret || null, Date.now());
  return id;
}

async function fireWebhook(intentId, event, data) {
  const hook = db.prepare('SELECT * FROM webhooks WHERE intent_id = ? AND fired = 0').get(intentId);
  if (!hook) return;

  try {
    const payload = JSON.stringify({
      intentId,
      event,
      actor: data.approver || data.rejector || 'system',
      firedAt: new Date().toISOString(),
      ...data
    });

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const { URL } = await import('url');
    const u = new URL(hook.url);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(hook.secret ? { 'X-Gate-Secret': hook.secret } : {})
      }
    });
    req.on('error', (e) => console.error(`[gate] webhook HTTP error for ${intentId}:`, e.message));
    req.write(payload);
    req.end();

    // Mark fired in DB
    db.prepare('UPDATE webhooks SET fired = 1, fired_at = ? WHERE id = ?')
      .run(Date.now(), hook.id);

    console.log(`[gate] webhook fired: ${intentId} → ${event} → ${hook.url}`);
  } catch (e) {
    console.error(`[gate] webhook failed for ${intentId}:`, e.message);
  }
}

// ── APPROVE ───────────────────────────────────────────────────────────────

function requireReviewer(req, res) {
  const role = req.agent?.role || 'agent';
  if (role !== 'admin' && role !== 'reviewer') {
    res.status(403).json({ error: 'forbidden', message: 'Reviewer API key required for approvals' });
    return false;
  }
  return true;
}

// POST /v1/approve  (V1 backward compat — body.proposalId)
router.post('/approve', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
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
    const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(proposalId);
    return res.json({
      status: 'approved',
      approvedAt: new Date().toISOString(),
      intentId: proposalId,
      deliveryToken: manifest?.delivery_token
    });
  }

  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposalId);
    logEvent(proposalId, 'expired', 'system', {});
    return res.status(410).json({ error: 'Proposal has expired' });
  }

  const deliveryToken = generateDeliveryToken();
  db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").run(proposalId);
  db.prepare(`
    INSERT INTO manifests (id, proposal_id, signed_by, delivery_token)
    VALUES (?, ?, ?, ?)
  `).run(generateId('mfst'), proposalId, req.agent.name, deliveryToken);

  logEvent(proposalId, 'approved', req.agent.name, { approver: req.agent.name });
  fireWebhook(proposalId, 'approved', { approver: req.agent.name });

  // Run Ledger integration (find run by on_behalf_of agent if present)
  if (proposal.on_behalf_of) {
    const runs = db.prepare('SELECT * FROM run_ledgers WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
      .all(proposal.on_behalf_of, 'active');
    if (runs.length > 0) {
      RunLedger.recordEvent({
        ledgerId: runs[0].id,
        eventType: EVENT_TYPES.APPROVAL_RECEIVED,
        actorId: req.agent.id,
        payload: { intentId: proposalId, approver: req.agent.name }
      });
    }
  }

  // gate_exec: if vault has a credential for this destination, Gate executes the call itself
  const { hasCredential } = require('../proxy/vault');
  const { executeIntent }  = require('../proxy/executor');
  const isGateExec = hasCredential(proposal.destination) && process.env.PROXY_API_KEY;

  // Release any held proxy connection (HTTP or HTTPS) for this intent
  try {
    const holdQueue = require('../proxy/hold-queue');
    const held = holdQueue.release(proposalId);
    if (held) {
      console.log(`[hold-queue] release ${proposalId} (${held.request?.type || 'http'})`);
      try { held.resolve(); } catch (e) { console.error('[hold-queue] resolve error:', e.message); }
    }
  } catch {}

  if (isGateExec) {
    // Fire async — don't block the approval response
    setImmediate(async () => {
      try {
        // Read payload content from disk if stored as file
        let payloadContent = null;
        if (proposal.payload_path) {
          const fs = require('fs');
          try { payloadContent = fs.readFileSync(proposal.payload_path, 'utf8'); } catch {}
        }
        const result = await executeIntent({
          id: proposalId,
          destination: proposal.destination,
          payloadContent,
        });
        console.log(`[gate_exec] ${proposalId} → ${result.succeeded ? 'succeeded' : 'failed'} (HTTP ${result.httpStatus})`);
      } catch (e) {
        console.error(`[gate_exec] Error executing ${proposalId}:`, e.message);
      }
    });
  } else if (AUTO_DELIVER_DESTINATIONS.includes(proposal.destination)) {
    autoDeliver(proposalId, proposal.destination, deliveryToken);
  }

  res.json({
    status: 'approved',
    approvedAt: new Date().toISOString(),
    intentId: proposalId,
    deliveryToken,
    autoDeliver: isGateExec ? false : AUTO_DELIVER_DESTINATIONS.includes(proposal.destination),
    gate_exec: isGateExec,
  });
});

// ── REJECT ────────────────────────────────────────────────────────────────

// POST /v1/reject  (V1 backward compat — body.proposalId)
router.post('/reject', authenticate, (req, res) => {
  if (!requireReviewer(req, res)) return;
  const { proposalId, reason } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (['blocked', 'delivered', 'expired'].includes(proposal.status)) {
    return res.status(409).json({ error: `Cannot reject proposal with status: ${proposal.status}` });
  }

  db.prepare("UPDATE proposals SET status = 'blocked', block_reason = ? WHERE id = ?")
    .run(reason || 'Rejected by reviewer', proposalId);

  // If proxy is holding a live connection, cancel it now.
  try {
    const holdQueue = require('../proxy/hold-queue');
    holdQueue.cancel(proposalId, reason || 'rejected');
  } catch {}

  logEvent(proposalId, 'rejected', req.agent.name, { reason, rejector: req.agent.name });
  fireWebhook(proposalId, 'rejected', { reason, rejector: req.agent.name });

  res.json({ status: 'blocked', reason });
});

// ── WEBHOOK REGISTRATION ──────────────────────────────────────────────────

// POST /v1/webhooks/register
router.post('/webhooks/register', authenticate, (req, res) => {
  const intentId = req.body.intentId || req.body.proposalId;
  const { url, secret } = req.body;
  if (!intentId || !url) {
    return res.status(400).json({ error: 'intentId and url are required' });
  }
  const proposal = db.prepare('SELECT id FROM proposals WHERE id = ?').get(intentId);
  if (!proposal) return res.status(404).json({ error: 'Intent not found' });

  const whkId = registerWebhook(intentId, url, secret);
  res.json({ registered: true, webhookId: whkId, intentId, url });
});

module.exports = router;
module.exports.registerWebhook = registerWebhook;
module.exports.fireWebhook = fireWebhook;
