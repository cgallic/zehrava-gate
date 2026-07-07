const express = require('express');
const router = express.Router();
const { getAuditTrail } = require('../lib/audit');
const { getApprovalEvidence } = require('../lib/evidence');
const { authenticate } = require('../middleware/auth');

// GET /v1/audit/:proposalId
router.get('/:proposalId', authenticate, (req, res) => {
  const trail = getAuditTrail(req.params.proposalId);
  const evidence = getApprovalEvidence(req.params.proposalId);
  res.json({ proposalId: req.params.proposalId, events: trail, count: trail.length, approval_evidence: evidence });
});

module.exports = router;
