const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const POLICY_DIR = process.env.POLICY_DIR || path.join(__dirname, '../../../../policies');

/**
 * Normalize text for term matching:
 * lowercases, strips special chars/obfuscation, collapses whitespace.
 * Defeats simple bypass attempts like "r3fund-guaranteed" or "refund  guaranteed".
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation/special chars
    .replace(/0/g, 'o')            // leet: 0 → o
    .replace(/1/g, 'i')            // leet: 1 → i
    .replace(/3/g, 'e')            // leet: 3 → e
    .replace(/4/g, 'a')            // leet: 4 → a
    .replace(/5/g, 's')            // leet: 5 → s
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();
}

const policyCache = {};

// Invalidate cache when policy files change on disk
function watchPolicies() {
  if (!fs.existsSync(POLICY_DIR)) return;
  fs.watch(POLICY_DIR, (event, filename) => {
    if (filename && filename.endsWith('.yaml')) {
      const policyId = filename.replace('.yaml', '');
      if (policyCache[policyId]) {
        delete policyCache[policyId];
        console.log(`[gate] Policy cache invalidated: ${policyId}`);
      }
    }
  });
}
watchPolicies();

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

  // Type check — only enforce if payloadType is a simple extension (not a full content string)
  if (policy.allowed_types && payloadType && payloadType.length < 20 && !payloadType.includes(' ')) {
    const ext = payloadType.toLowerCase().replace('.', '');
    if (!policy.allowed_types.includes(ext)) {
      return {
        status: 'blocked',
        reason: `Payload type '${ext}' not allowed. Allowed: [${policy.allowed_types.join(', ')}]`
      };
    }
  }

  // Sensitive term check — normalized matching defeats simple obfuscation
  if (policy.block_if_terms && payloadContent) {
    const normalizedContent = normalizeText(payloadContent);
    for (const term of policy.block_if_terms) {
      const normalizedTerm = normalizeText(term);
      if (normalizedContent.includes(normalizedTerm)) {
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
