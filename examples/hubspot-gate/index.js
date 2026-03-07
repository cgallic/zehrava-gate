/**
 * Example: HubSpot CRM Update Gate
 *
 * Agent enriches leads and proposes a CRM update.
 * Bus evaluates policy → pending_approval (bulk write over threshold)
 * Manager approves → Gate delivers.
 *
 * Run: node examples/hubspot-gate/index.js
 */

const { Gate } = require('../../packages/gate-sdk-js/src/index');
const http = require('http');

const GATE_URL = process.env.GATE_URL || 'http://localhost:3001';

async function run() {
  console.log('\n=== Zehrava Gate Demo: HubSpot CRM Update Gate ===\n');

  // 1. Register an agent
  console.log('Step 1: Registering enrichment agent...');
  const regRes = await fetch(`${GATE_URL}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'kai-enrichment-agent', riskTier: 'standard' })
  });
  const { agentId, apiKey } = await regRes.json();
  console.log(`  Agent registered: ${agentId}`);

  const gate = new Gate({ endpoint: GATE_URL, apiKey });

  // 2. Agent proposes CRM update (150 records — over auto-approve threshold of 100)
  console.log('\nStep 2: Agent proposes CRM update (150 records)...');
  const proposal = await gate.propose({
    payload: 'enriched-leads.csv',
    destination: 'hubspot.contacts',
    policy: 'crm-low-risk',
    recordCount: 150,
    expiresIn: '1h'
  });

  console.log(`  Proposal ID: ${proposal.proposalId}`);
  console.log(`  Status: ${proposal.status}`);  // pending_approval
  if (proposal.blockReason) console.log(`  Reason: ${proposal.blockReason}`);

  if (proposal.status === 'blocked') {
    console.log('\n  BLOCKED. Nothing reaches CRM. ✗');
    return;
  }

  // 3. Manager approves
  console.log('\nStep 3: Manager reviews and approves...');
  const approval = await gate.approve({ proposalId: proposal.proposalId });
  console.log(`  Status: ${approval.status}`);
  console.log(`  Delivery token: ${approval.deliveryToken}`);

  // 4. Gate delivers
  console.log('\nStep 4: Gate delivers to HubSpot...');
  const delivery = await gate.deliver({ proposalId: proposal.proposalId });
  console.log(`  Delivery URL: ${delivery.url}`);
  console.log(`  Expires at: ${delivery.expiresAt}`);

  // 5. Verify — full audit trail
  console.log('\nStep 5: Verify audit trail...');
  const verified = await gate.verify({ proposalId: proposal.proposalId });
  console.log(`  Final status: ${verified.status}`);
  console.log(`  Audit events:`);
  for (const event of verified.auditTrail) {
    console.log(`    [${event.created_at}] ${event.event_type} — ${event.actor}`);
  }

  console.log('\n✓ Done. Every write gated, every action audited.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
