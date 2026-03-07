/**
 * Example: Zendesk Support Reply Gate
 *
 * Agent drafts a support reply. Policy: support-reply (auto-approve for single messages,
 * block if reply contains dangerous terms like "refund guaranteed").
 *
 * Run: node examples/zendesk-gate/index.js
 */

const { Gate } = require('../../packages/gate-sdk-js/src/index');

const GATE_URL = process.env.GATE_URL || 'http://localhost:3001';

async function run() {
  console.log('\n=== Zehrava Gate Demo: Zendesk Support Reply Gate ===\n');

  const regRes = await fetch(`${GATE_URL}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'kai-support-agent', riskTier: 'standard' })
  });
  const { agentId, apiKey } = await regRes.json();
  console.log(`Agent: ${agentId}`);

  const gate = new Gate({ endpoint: GATE_URL, apiKey });

  // Scenario A: Safe reply — auto-approved
  console.log('\n--- Scenario A: Safe support reply (auto-approve) ---');
  const safeReply = await gate.propose({
    payload: 'Hi! Thanks for reaching out. I\'ve escalated your ticket to our team.',
    destination: 'zendesk.reply',
    policy: 'support-reply',
    recordCount: 1,
    expiresIn: '30m'
  });
  console.log(`Status: ${safeReply.status}`);  // approved
  console.log('→ Low risk, auto-approved. ✓');

  if (safeReply.status === 'approved') {
    const delivery = await gate.deliver({ proposalId: safeReply.proposalId });
    console.log(`Delivered: ${delivery.url}`);
  }

  // Scenario B: Risky reply — blocked by term detection
  console.log('\n--- Scenario B: Reply contains "refund guaranteed" (blocked) ---');
  const riskyReply = await gate.propose({
    payload: 'Hi! We have reviewed your case and a refund guaranteed within 24 hours.',
    destination: 'zendesk.reply',
    policy: 'support-reply',
    recordCount: 1,
    expiresIn: '30m'
  });
  console.log(`Status: ${riskyReply.status}`);  // blocked
  console.log(`Reason: ${riskyReply.blockReason}`);
  console.log('→ Reply blocked. Agent cannot make refund guarantees. ✗');

  // Full audit trail for blocked proposal
  const audit = await gate.verify({ proposalId: riskyReply.proposalId });
  console.log('\nAudit trail:');
  for (const event of audit.auditTrail) {
    console.log(`  [${event.event_type}] ${event.actor}`);
  }

  console.log('\n✓ Safe replies through, risky replies blocked. Every decision logged.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
