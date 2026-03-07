const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../lib/db');
const { logEvent } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

// POST /v1/deliver
router.post('/deliver', authenticate, (req, res) => {
  const { proposalId } = req.body;
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (proposal.status !== 'approved') {
    return res.status(409).json({
      error: `Cannot deliver proposal with status: ${proposal.status}`,
      status: proposal.status
    });
  }

  const manifest = db.prepare('SELECT * FROM manifests WHERE proposal_id = ?').get(proposalId);
  if (!manifest) return res.status(500).json({ error: 'Manifest not found for approved proposal' });

  if (manifest.delivered_at) {
    return res.status(410).json({ error: 'Proposal already delivered. One-time delivery enforced.' });
  }

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const deliveryUrl = `${baseUrl}/v1/download/${manifest.delivery_token}`;

  logEvent(proposalId, 'delivery_url_issued', req.agent.name, { destination: proposal.destination });

  res.json({
    url: deliveryUrl,
    deliveryToken: manifest.delivery_token,
    expiresAt: proposal.expires_at ? new Date(proposal.expires_at).toISOString() : null
  });
});

// GET /v1/download/:token  — one-time retrieval
router.get('/download/:token', (req, res) => {
  const manifest = db.prepare('SELECT * FROM manifests WHERE delivery_token = ?').get(req.params.token);
  if (!manifest) return res.status(404).json({ error: 'Invalid delivery token' });

  if (manifest.delivered_at) {
    return res.status(410).json({ error: 'This payload has already been delivered. One-time access enforced.' });
  }

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(manifest.proposal_id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  // Check expiry
  if (proposal.expires_at && Date.now() > proposal.expires_at) {
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(proposal.id);
    logEvent(proposal.id, 'expired', 'system', {});
    return res.status(410).json({ error: 'Delivery link has expired' });
  }

  // Mark as delivered
  db.prepare('UPDATE manifests SET delivered_at = ? WHERE id = ?').run(Date.now(), manifest.id);
  db.prepare("UPDATE proposals SET status = 'delivered' WHERE id = ?").run(proposal.id);

  logEvent(proposal.id, 'delivered', 'system', {
    destination: proposal.destination,
    token: req.params.token
  });

  // Serve payload if stored
  if (proposal.payload_path && fs.existsSync(proposal.payload_path)) {
    return res.download(proposal.payload_path);
  }

  // Return metadata if no file
  res.json({
    proposalId: proposal.id,
    destination: proposal.destination,
    policy: proposal.policy_id,
    deliveredAt: new Date().toISOString(),
    payloadHash: proposal.payload_hash
  });
});

module.exports = router;
