const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const POLICY_DIR = process.env.POLICY_DIR || path.join(__dirname, '../../../../policies');

const policyCache = {};

function loadPolicy(policyId) {
  if (policyCache[policyId]) return policyCache[policyId];

  const filePath = path.join(POLICY_DIR, `${policyId}.yaml`);
  if (!fs.existsSync(filePath)) return null;

  const policy = yaml.load(fs.readFileSync(filePath, 'utf8'));
  policyCache[policyId] = policy;
  return policy;
}

function listPolicies() {
  if (!fs.existsSync(POLICY_DIR)) return [];
  return fs.readdirSync(POLICY_DIR)
    .filter(f => f.endsWith('.yaml'))
    .map(f => f.replace('.yaml', ''));
}

/**
 * Evaluate a proposal against a policy.
 * Returns { status: 'approved' | 'blocked' | 'pending_approval', reason? }
 */
function evaluatePolicy(policyId, { destination, payloadType, payloadContent, recordCount, metadata }) {
  const policy = loadPolicy(policyId);

  if (!policy) {
    return { status: 'blocked', reason: `Policy '${policyId}' not found` };
  }

  // Destination check
  if (policy.destinations && !policy.destinations.includes(destination)) {
    return {
      status: 'blocked',
      reason: `Destination '${destination}' not in policy allowlist: [${policy.destinations.join(', ')}]`
    };
  }

  // Type check
  if (policy.allowed_types && payloadType) {
    const ext = payloadType.toLowerCase().replace('.', '');
    if (!policy.allowed_types.includes(ext)) {
      return {
        status: 'blocked',
        reason: `Payload type '${ext}' not allowed. Allowed: [${policy.allowed_types.join(', ')}]`
      };
    }
  }

  // Sensitive term check
  if (policy.block_if_terms && payloadContent) {
    for (const term of policy.block_if_terms) {
      if (payloadContent.toLowerCase().includes(term.toLowerCase())) {
        return { status: 'blocked', reason: `Payload contains blocked term: "${term}"` };
      }
    }
  }

  // Always require approval
  if (policy.require_approval === 'always') {
    return { status: 'pending_approval', reason: 'Policy requires human approval' };
  }

  // Record count thresholds
  if (recordCount !== undefined) {
    if (policy.require_approval_over && recordCount > policy.require_approval_over) {
      return {
        status: 'pending_approval',
        reason: `Record count ${recordCount} exceeds auto-approve threshold (${policy.require_approval_over})`
      };
    }
    if (policy.auto_approve_under && recordCount <= policy.auto_approve_under) {
      return { status: 'approved' };
    }
  }

  // Org-wide check
  if (policy.require_approval_for === 'org_wide' && metadata?.scope === 'org_wide') {
    return { status: 'pending_approval', reason: 'Org-wide publish requires approval' };
  }

  // Default: pending approval (safe default)
  return { status: 'pending_approval', reason: 'Awaiting review' };
}

module.exports = { loadPolicy, listPolicies, evaluatePolicy };
