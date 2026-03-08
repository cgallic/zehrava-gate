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
function evaluatePolicy(policyId, { destination, payloadType, payloadContent, recordCount, metadata, agentId }) {
  const policy = loadPolicy(policyId);

  if (!policy) {
    return { status: 'blocked', reason: `Policy '${policyId}' not found` };
  }

  // 1. Destination check
  if (policy.destinations && !policy.destinations.includes(destination)) {
    return {
      status: 'blocked',
      reason: `Destination '${destination}' not in policy allowlist: [${policy.destinations.join(', ')}]`
    };
  }

  // 2. Type check
  if (policy.allowed_types && payloadType && payloadType.length < 20 && !payloadType.includes(' ')) {
    const ext = payloadType.toLowerCase().replace('.', '');
    if (!policy.allowed_types.includes(ext)) {
      return {
        status: 'blocked',
        reason: `Payload type '${ext}' not allowed. Allowed: [${policy.allowed_types.join(', ')}]`
      };
    }
  }

  // 3. Environment-aware thresholds overrides
  let activePolicy = { ...policy };
  if (policy.environments && metadata?.environment) {
    const envConfig = policy.environments[metadata.environment];
    if (envConfig) {
      activePolicy = { ...activePolicy, ...envConfig };
    }
  }

  // 4. Rate limiting (requires agentId)
  if (activePolicy.rate_limits && agentId) {
    const rl = evaluateRateLimits(activePolicy.rate_limits, agentId);
    if (rl.blocked) return { status: 'blocked', reason: rl.reason };
  }

  // 5. Schema/Field checks (JSON payloads only)
  if (activePolicy.field_checks && payloadContent) {
    try {
      const json = typeof payloadContent === 'string' ? JSON.parse(payloadContent) : payloadContent;
      const fieldResult = evaluateFieldChecks(activePolicy.field_checks, json);
      if (fieldResult.blocked) {
        return { status: 'blocked', reason: fieldResult.reason };
      }
    } catch (e) {
      // Not JSON or parse error — ignore field checks if payload isn't valid JSON
      // Unless policy strictly requires JSON? For now, we skip.
    }
  }

  // 6. Sensitive term check
  if (activePolicy.block_if_terms && payloadContent) {
    const contentStr = typeof payloadContent === 'string' ? payloadContent : JSON.stringify(payloadContent);
    const normalizedContent = normalizeText(contentStr);
    for (const term of activePolicy.block_if_terms) {
      const normalizedTerm = normalizeText(term);
      if (normalizedContent.includes(normalizedTerm)) {
        return { status: 'blocked', reason: `Payload contains blocked term: "${term}"` };
      }
    }
  }

  // 7. Always require approval
  if (activePolicy.require_approval === 'always') {
    return { status: 'pending_approval', reason: 'Policy requires human approval' };
  }

  // 8. Record count thresholds
  if (recordCount !== undefined) {
    if (activePolicy.require_approval_over && recordCount > activePolicy.require_approval_over) {
      return {
        status: 'pending_approval',
        reason: `Record count ${recordCount} exceeds auto-approve threshold (${activePolicy.require_approval_over})`
      };
    }
    if (activePolicy.auto_approve_under && recordCount <= activePolicy.auto_approve_under) {
      return { status: 'approved' };
    }
  }

  // 9. Org-wide check
  if (activePolicy.require_approval_for === 'org_wide' && metadata?.scope === 'org_wide') {
    return { status: 'pending_approval', reason: 'Org-wide publish requires approval' };
  }

  // Default
  return { status: 'pending_approval', reason: 'Awaiting review' };
}

/**
 * Validate JSON fields against policy rules
 */
function evaluateFieldChecks(checks, json) {
  for (const check of checks) {
    // Resolve dot notation path
    const parts = check.path.split('.');
    let val = json;
    for (const part of parts) {
      val = (val && val[part] !== undefined) ? val[part] : undefined;
    }

    // Required check
    if (check.required && (val === undefined || val === null || val === '')) {
      return { blocked: true, reason: `Field '${check.path}' is required but missing/empty` };
    }

    if (val === undefined) continue; // Skip other checks if field missing (unless required)

    // Max/Min (numeric)
    if (typeof val === 'number') {
      if (check.max !== undefined && val > check.max) {
        return { blocked: true, reason: `Field '${check.path}' value ${val} exceeds max ${check.max}` };
      }
      if (check.min !== undefined && val < check.min) {
        return { blocked: true, reason: `Field '${check.path}' value ${val} is below min ${check.min}` };
      }
    }

    // Max Length (string/array)
    if (check.max_length !== undefined) {
      const len = val && val.length;
      if (len !== undefined && len > check.max_length) {
        return { blocked: true, reason: `Field '${check.path}' length ${len} exceeds max ${check.max_length}` };
      }
    }

    // Pattern (regex)
    if (check.pattern && typeof val === 'string') {
      const regex = new RegExp(check.pattern);
      if (!regex.test(val)) {
        return { blocked: true, reason: `Field '${check.path}' format invalid` };
      }
    }
  }
  return { blocked: false };
}

function evaluateRateLimits(rateLimits, agentId) {
  try {
    const db = require('./db');
    const now = Date.now();

    if (rateLimits.per_agent_per_hour) {
      const since = now - 60 * 60 * 1000;
      const row = db.prepare('SELECT COUNT(*) AS c FROM proposals WHERE sender_agent_id = ? AND created_at >= ?').get(agentId, since);
      if ((row?.c || 0) >= rateLimits.per_agent_per_hour) {
        return { blocked: true, reason: `Rate limit exceeded: ${rateLimits.per_agent_per_hour}/hour for agent ${agentId}` };
      }
    }

    if (rateLimits.per_agent_per_day) {
      const since = now - 24 * 60 * 60 * 1000;
      const row = db.prepare('SELECT COUNT(*) AS c FROM proposals WHERE sender_agent_id = ? AND created_at >= ?').get(agentId, since);
      if ((row?.c || 0) >= rateLimits.per_agent_per_day) {
        return { blocked: true, reason: `Rate limit exceeded: ${rateLimits.per_agent_per_day}/day for agent ${agentId}` };
      }
    }

    return { blocked: false };
  } catch (e) {
    // Fail-closed on rate limit evaluation errors
    return { blocked: true, reason: `Rate limit check failed: ${e.message}` };
  }
}

module.exports = { loadPolicy, listPolicies, evaluatePolicy };
