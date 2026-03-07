/**
 * Integration test for Zehrava Gate
 * Run: node test.js
 */

const { Gate } = require('./packages/gate-sdk-js/src/index');

const GATE_URL = process.env.GATE_URL || 'http://localhost:3001';
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function run() {
  console.log('\n=== Zehrava Gate Integration Test ===\n');

  // 1. Health check
  console.log('Health check...');
  const health = await fetch(`${GATE_URL}/health`).then(r => r.json());
  assert(health.status === 'ok', `Health: ${health.status}`);

  // 2. Register agent
  console.log('\nAgent registration...');
  const regRes = await fetch(`${GATE_URL}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-agent', riskTier: 'standard' })
  });
  const { agentId, apiKey } = await regRes.json();
  assert(agentId && agentId.startsWith('agt_'), `Agent ID: ${agentId}`);
  assert(apiKey && apiKey.startsWith('gate_sk_'), `API key format`);

  const gate = new Gate({ endpoint: GATE_URL, apiKey });

  // 3. Propose — pending (over threshold)
  console.log('\nPropose (pending_approval)...');
  const p1 = await gate.propose({
    payload: 'leads.csv', destination: 'salesforce.import',
    policy: 'crm-low-risk', recordCount: 200
  });
  assert(p1.proposalId, `Proposal ID: ${p1.proposalId}`);
  assert(p1.status === 'pending_approval', `Status: ${p1.status}`);

  // 4. Approve
  console.log('\nApprove...');
  const approval = await gate.approve({ proposalId: p1.proposalId });
  assert(approval.status === 'approved', `Approved`);
  assert(approval.deliveryToken && approval.deliveryToken.startsWith('dlv_'), `Token: ${approval.deliveryToken}`);

  // 5. Deliver
  console.log('\nDeliver...');
  const delivery = await gate.deliver({ proposalId: p1.proposalId });
  assert(delivery.url && delivery.url.includes('/v1/download/'), `Delivery URL`);

  // 6. Verify
  console.log('\nVerify...');
  const verified = await gate.verify({ proposalId: p1.proposalId });
  assert(verified.status === 'approved', `Final status: approved`);
  assert(verified.auditTrail.length >= 3, `Audit trail has ${verified.auditTrail.length} events`);

  // 7. Propose — blocked (wrong destination)
  console.log('\nPropose (blocked — wrong destination)...');
  const p2 = await gate.propose({
    payload: 'payout.csv', destination: 'unknown.system',
    policy: 'finance-high-risk'
  });
  assert(p2.status === 'blocked', `Blocked: ${p2.blockReason}`);

  // 8. Propose — auto-approved (under threshold)
  console.log('\nPropose (auto-approved under threshold)...');
  const p3 = await gate.propose({
    payload: 'small.csv', destination: 'salesforce.import',
    policy: 'crm-low-risk', recordCount: 50
  });
  assert(p3.status === 'approved', `Auto-approved: ${p3.status}`);

  // 9. Reject
  console.log('\nReject...');
  const p4 = await gate.propose({
    payload: 'data.csv', destination: 'hubspot.contacts',
    policy: 'crm-low-risk', recordCount: 150
  });
  const rejection = await gate.reject({ proposalId: p4.proposalId, reason: 'PII detected in payload' });
  assert(rejection.status === 'blocked', `Rejected`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
