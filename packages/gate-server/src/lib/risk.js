/**
 * Risk scoring engine
 * Returns { risk_score: 0-1, risk_level: low|medium|high|critical, factors: [] }
 */

const SENSITIVE_FIELD_PATTERNS = [
  /\bssn\b/i, /\bpassport\b/i, /\bcredit.?card\b/i, /\bsocial.?security\b/i,
  /\biban\b/i, /\bswift\b/i, /\bcvv\b/i, /\baccount.?number\b/i,
  /\bdate.?of.?birth\b/i, /\bdob\b/i, /\bdiagnos/i, /\bmedical\b/i
];

const HIGH_RISK_DESTINATIONS = [
  'stripe.refund', 'stripe.charge', 'quickbooks.journal', 'netsuite.payment',
  'payroll.run', 'wire.transfer', 'ach.transfer', 'bank.transfer'
];

const MEDIUM_RISK_DESTINATIONS = [
  'salesforce.import', 'hubspot.contacts', 'marketo.import',
  'zendesk.reply', 'intercom.reply'
];

function scoreRisk({ destination, recordCount, estimatedValueUsd, sensitivityTags, payloadContent, policyRequireApproval }) {
  let score = 0;
  const factors = [];

  // Destination risk
  if (HIGH_RISK_DESTINATIONS.some(d => destination?.includes(d.split('.')[0]))) {
    score += 0.35; factors.push('high_risk_destination');
  } else if (MEDIUM_RISK_DESTINATIONS.some(d => destination?.includes(d.split('.')[0]))) {
    score += 0.15; factors.push('medium_risk_destination');
  }

  // Record count
  if (recordCount > 10000) { score += 0.30; factors.push('very_large_record_count'); }
  else if (recordCount > 1000) { score += 0.20; factors.push('large_record_count'); }
  else if (recordCount > 100) { score += 0.10; factors.push('elevated_record_count'); }

  // Financial value
  if (estimatedValueUsd > 10000) { score += 0.25; factors.push('high_financial_value'); }
  else if (estimatedValueUsd > 1000) { score += 0.15; factors.push('elevated_financial_value'); }
  else if (estimatedValueUsd > 0) { score += 0.05; factors.push('financial_value_present'); }

  // Sensitivity tags
  if (sensitivityTags?.includes('financial') || sensitivityTags?.includes('legal')) {
    score += 0.20; factors.push('sensitive_data_tagged');
  } else if (sensitivityTags?.includes('pii') || sensitivityTags?.includes('health')) {
    score += 0.15; factors.push('pii_tagged');
  }

  // Payload content scan for sensitive patterns
  if (payloadContent) {
    const matches = SENSITIVE_FIELD_PATTERNS.filter(p => p.test(payloadContent));
    if (matches.length > 0) { score += 0.15; factors.push('sensitive_fields_detected'); }
  }

  // Policy always requires approval
  if (policyRequireApproval === 'always') { score += 0.10; factors.push('policy_requires_approval'); }

  // Cap at 1.0
  score = Math.min(1.0, score);

  let risk_level;
  if (score >= 0.75) risk_level = 'critical';
  else if (score >= 0.50) risk_level = 'high';
  else if (score >= 0.25) risk_level = 'medium';
  else risk_level = 'low';

  return { risk_score: parseFloat(score.toFixed(2)), risk_level, factors };
}

module.exports = { scoreRisk };
