/**
 * Example: Finance Payout Batch Gate
 *
 * Agent generates a payout file. Policy: finance-high-risk (always require approval).
 * Demonstrates a BLOCKED scenario (wrong destination) and an APPROVAL scenario.
 *
 * Run: node examples/finance-gate/index.js
 */

const { Gate } = require('../../packages/gate-sdk-js/src/index');

const GATE_URL = process.env.GATE_URL || 'http://localhost:3001';

async function run() {
  console.log('\n=== Zehrava Gate Demo: Finance Payout Batch Gate ===\n');

  // Register agent
  const regRes = await fetch(`${GATE_URL}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'kai-finance-agent', riskTier: 'high' })
  });
  const { agentId, apiKey } = await regRes.json();
  console.log(`Agent: ${agentId}`);

  const gate = new Gate({ endpoint: GATE_URL, apiKey });

  // Scenario A: Wrong destination — should be BLOCKED
  console.log('\n--- Scenario A: Wrong destination ---');
  const blockedProposal = await gate.propose({
    payload: 'payout_batch_march.csv',
    destination: 'unknown.system',   // Not in policy allowlist
    policy: 'finance-high-risk',
    expiresIn: '30m'
  });
  console.log(`Status: ${blockedProposal.status}`);
  console.log(`Reason: ${blockedProposal.blockReason}`);
  console.log('→ Nothing moves. Destination not in allowlist. ✗');

  // Scenario B: Correct destination, requires human approval
  console.log('\n--- Scenario B: Correct destination (always requires approval) ---');
  const proposal = await gate.propose({
    payload: 'payout_batch_march.csv',
    destination: 'netsuite.payout',
    policy: 'finance-high-risk',
    expiresIn: '30m'
  });
  console.log(`Status: ${proposal.status}`);  // pending_approval
  console.log(`Proposal ID: ${proposal.proposalId}`);
  console.log(`Expires: ${proposal.expiresAt}`);
  console.log('→ Held in approval queue. Finance manager must approve.');

  // Approve and deliver
  console.log('\n--- Finance manager approves ---');
  const approval = await gate.approve({ proposalId: proposal.proposalId });
  console.log(`Approved. Token: ${approval.deliveryToken}`);

  const delivery = await gate.deliver({ proposalId: proposal.proposalId });
  console.log(`One-time delivery URL: ${delivery.url}`);

  // Attempt second download (should fail — one-time only)
  console.log('\n--- Attempt second delivery (one-time enforcement) ---');
  try {
    await gate.deliver({ proposalId: proposal.proposalId });
  } catch (err) {
    console.log(`Second deliver attempt: ${err.message}`);
    console.log('→ One-time delivery enforced. ✓');
  }

  console.log('\n✓ Finance payout gated, approved, delivered once, audited.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
