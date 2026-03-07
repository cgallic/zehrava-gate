const express = require('express');
const router = express.Router();
const { getAuditTrail } = require('../lib/audit');
const { authenticate } = require('../middleware/auth');

// GET /v1/audit/:proposalId
router.get('/:proposalId', authenticate, (req, res) => {
  const trail = getAuditTrail(req.params.proposalId);
  res.json({ proposalId: req.params.proposalId, events: trail, count: trail.length });
});

module.exports = router;
