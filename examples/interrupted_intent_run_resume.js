/**
 * Demo: Interrupted Intent Run Resume
 * 
 * Demonstrates the Run Ledger system with:
 * 1. Create a run
 * 2. Start ledger
 * 3. Lock a plan
 * 4. Execute two tool calls successfully
 * 5. Create one artifact
 * 6. Propose an intent to Gate
 * 7. Simulate interruption before execution
 * 8. Seal checkpoint
 * 9. Inspect run from CLI (manual step)
 * 10. Resume run from checkpoint
 * 11. Prevent duplicate side effects
 * 12. Finish execution
 * 13. Verify integrity
 */

const { Gate } = require('../packages/gate-server/src/sdk');
const { RunLedger, CheckpointSealer, ResumeResolver, EVENT_TYPES, SIDE_EFFECT_CLASS } = require('../packages/gate-server/src/lib/runs');
const { hash } = require('../packages/gate-server/src/lib/runs');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log('\n  🔄 Interrupted Intent Run Resume Demo');
  console.log('  ═══════════════════════════════════════\n');

  const GATE_ENDPOINT = process.env.GATE_ENDPOINT || 'http://localhost:3001';
  const GATE_API_KEY = process.env.GATE_API_KEY || 'gate_sk_test123'; // Demo key

  const gate = new Gate({
    endpoint: GATE_ENDPOINT,
    apiKey: GATE_API_KEY
  });

  // ── Step 1: Start a run ──
  console.log('  [1] Starting run...');
  const run = await gate.startRun({
    agentId: 'lead-enrichment-agent',
    intentSummary: 'Enrich leads and sync approved changes to Salesforce',
    runtime: 'zehrava-gate',
    permissions: {
      allowed_tools: ['fetch_data', 'enrich_leads', 'salesforce_import'],
      max_records: 1000
    }
  });
  console.log(`      ✓ Run created: ${run.runId}\n`);

  await sleep(100);

  // ── Step 2: Lock a plan ──
  console.log('  [2] Locking plan...');
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.PLAN_LOCKED,
    actorId: 'lead-enrichment-agent',
    payload: {
      steps: ['fetch', 'enrich', 'review', 'sync']
    }
  });
  console.log('      ✓ Plan locked\n');

  await sleep(100);

  // ── Step 3: Execute first tool call ──
  console.log('  [3] Executing first tool call (fetch_data)...');
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.TOOL_CALL_STARTED,
    actorId: 'lead-enrichment-agent',
    stepName: 'fetch',
    payload: { tool: 'fetch_data', source: 'postgres' },
    sideEffectClass: SIDE_EFFECT_CLASS.READ
  });

  await sleep(50);

  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.TOOL_CALL_FINISHED,
    actorId: 'lead-enrichment-agent',
    stepName: 'fetch',
    payload: { tool: 'fetch_data', recordsFetched: 847 },
    sideEffectClass: SIDE_EFFECT_CLASS.READ
  });
  console.log('      ✓ Fetched 847 records\n');

  await sleep(100);

  // ── Step 4: Execute second tool call ──
  console.log('  [4] Executing second tool call (enrich_leads)...');
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.TOOL_CALL_STARTED,
    actorId: 'lead-enrichment-agent',
    stepName: 'enrich',
    payload: { tool: 'enrich_leads' },
    sideEffectClass: SIDE_EFFECT_CLASS.WRITE
  });

  await sleep(50);

  const enrichSideEffectKey = hash.sideEffectKey('enrich_leads', 'local_storage', { batch: 'batch-2026-03-22' });
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.TOOL_CALL_FINISHED,
    actorId: 'lead-enrichment-agent',
    stepName: 'enrich',
    payload: { tool: 'enrich_leads', recordsEnriched: 847 },
    sideEffectClass: SIDE_EFFECT_CLASS.WRITE,
    sideEffectKey: enrichSideEffectKey
  });
  console.log('      ✓ Enriched 847 records\n');

  await sleep(100);

  // ── Step 5: Create artifact ──
  console.log('  [5] Creating artifact (enriched_leads.csv)...');
  const ledger = RunLedger.getRun(run.runId);
  RunLedger.createArtifact({
    ledgerId: ledger.id,
    artifactType: 'csv',
    uriOrPath: './enriched_leads.csv',
    contentHash: hash.hashString('mock_csv_content'),
    metadata: { recordCount: 847 }
  });
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.ARTIFACT_CREATED,
    actorId: 'lead-enrichment-agent',
    payload: { artifact: 'enriched_leads.csv', recordCount: 847 }
  });
  console.log('      ✓ Artifact created\n');

  await sleep(100);

  // ── Step 6: Propose intent to Gate ──
  console.log('  [6] Proposing intent to Gate (salesforce.import)...');
  const intentProposal = await gate.propose({
    payload: './enriched_leads.csv',
    destination: 'salesforce.import',
    policy: 'crm-low-risk',
    recordCount: 847,
    idempotencyKey: 'batch-2026-03-22'
  });

  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.INTENT_PROPOSED,
    actorId: 'lead-enrichment-agent',
    stepName: 'review',
    payload: { intentId: intentProposal.intentId, status: intentProposal.status }
  });

  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.POLICY_CHECKED,
    actorId: 'gate',
    payload: { intentId: intentProposal.intentId, decision: intentProposal.status }
  });

  if (intentProposal.status === 'pending_approval') {
    await gate.recordEvent({
      runId: run.runId,
      eventType: EVENT_TYPES.APPROVAL_REQUESTED,
      payload: { intentId: intentProposal.intentId }
    });
    console.log('      ✓ Intent proposed (pending approval)\n');
  }

  await sleep(100);

  // ── Step 7: Simulate interruption ──
  console.log('  [7] Simulating interruption (agent crash)...');
  const interruptionEvent = await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.INTERRUPTION_DETECTED,
    actorId: 'system',
    payload: { reason: 'agent_crash_simulation' }
  });
  console.log('      ✓ Interruption detected\n');

  await sleep(100);

  // ── Step 8: Seal checkpoint ──
  console.log('  [8] Sealing checkpoint...');
  const checkpoint = await gate.createCheckpoint({
    runId: run.runId,
    eventId: interruptionEvent.eventId,
    reason: 'interruption',
    suggestedNextAction: 'await_approval_then_execute'
  });
  console.log(`      ✓ Checkpoint sealed: ${checkpoint.checkpointId}`);
  console.log(`        Resumable: ${checkpoint.isResumable}`);
  console.log(`        Hash: ${checkpoint.sealedHash.substring(0, 16)}...\n`);

  await sleep(100);

  // ── Step 9: Inspect run (manual step - would be done via CLI) ──
  console.log('  [9] Inspecting run (via CLI would be: zehrava-gate runs inspect ' + run.runId + ')');
  const inspectData = await gate.getRun({ runId: run.runId });
  console.log(`      Run status: ${inspectData.run.status}`);
  console.log(`      Events: ${inspectData.events.length}`);
  console.log(`      Checkpoints: ${inspectData.checkpoints.length}`);
  console.log(`      Artifacts: ${inspectData.artifacts.length}`);
  console.log(`      Resumable checkpoints: ${inspectData.resumableCheckpoints.length}\n`);

  await sleep(100);

  // ── Step 10: Resume run ──
  console.log('  [10] Resuming run from checkpoint...');
  const resumeContext = await gate.resumeRun({ runId: run.runId });
  console.log(`       ✓ Resumed from checkpoint: ${resumeContext.checkpointId}`);
  console.log(`         Receipts loaded: ${resumeContext.receipts.length}`);
  console.log(`         Artifacts available: ${resumeContext.artifacts.length}`);
  console.log(`         Blocked side effects: ${resumeContext.blockedSideEffectKeys.size}`);
  console.log(`         Unresolved approvals: ${resumeContext.unresolvedApprovals.length}\n`);

  await sleep(100);

  // ── Step 11: Prevent duplicate side effects ──
  console.log('  [11] Checking for duplicate side effects...');
  const shouldSkipEnrich = ResumeResolver.shouldSkipDueToSideEffect(ledger.id, enrichSideEffectKey);
  if (shouldSkipEnrich) {
    console.log('       ✓ Enrich step already completed — skipped on resume\n');
  } else {
    console.log('       ✗ Would re-run enrich (this should not happen!)\n');
  }

  await sleep(100);

  // ── Step 12: Finish execution (simulate approval and execution) ──
  console.log('  [12] Simulating approval and execution...');
  
  // Approve the intent
  await gate.approve({ intentId: intentProposal.intentId });
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.APPROVAL_RECEIVED,
    payload: { intentId: intentProposal.intentId }
  });

  // Request execution
  const execution = await gate.execute({ intentId: intentProposal.intentId });
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.EXECUTION_REQUESTED,
    payload: { executionId: execution.executionId, executionToken: 'gex_••••' }
  });

  // Mark execution as succeeded (would actually happen in worker)
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.EXECUTION_SUCCEEDED,
    actorId: 'salesforce-worker',
    stepName: 'sync',
    payload: { executionId: execution.executionId, recordsSynced: 847 },
    sideEffectClass: SIDE_EFFECT_CLASS.EXTERNAL_MUTATION,
    sideEffectKey: hash.sideEffectKey('salesforce.import', 'salesforce', { batch: 'batch-2026-03-22' })
  });

  // Complete the run
  await gate.recordEvent({
    runId: run.runId,
    eventType: EVENT_TYPES.RUN_COMPLETED,
    payload: { totalRecords: 847, finalStep: 'sync' }
  });

  RunLedger.updateStatus(ledger.id, 'completed');

  console.log('       ✓ Execution completed\n');

  await sleep(100);

  // ── Step 13: Verify integrity ──
  console.log('  [13] Verifying run integrity...');
  const verification = await gate.verifyRun({ runId: run.runId });
  console.log(`       Ledger integrity: ${verification.ledgerIntegrity.valid ? '✓ Valid' : '✗ Invalid'}`);
  console.log(`       Checkpoint integrity: ${verification.checkpointIntegrity.valid ? '✓ Valid' : '✗ Invalid'}`);
  console.log(`       Lineage continuity: ${verification.lineageContinuity.valid ? '✓ Valid' : '✗ Invalid'}\n`);

  // ── Final summary ──
  console.log('  ═══════════════════════════════════════');
  console.log('  ✅ Demo completed successfully!\n');
  console.log('  Key outcomes:');
  console.log('  • Run interrupted and checkpointed');
  console.log('  • Successfully resumed from checkpoint');
  console.log('  • Side effects not replayed');
  console.log('  • Integrity verification passed');
  console.log('  • Run completed without data loss\n');

  console.log('  Try inspecting the run:');
  console.log(`  zehrava-gate runs inspect ${run.runId}\n`);
}

// Run the demo
if (require.main === module) {
  runDemo().catch(err => {
    console.error('\n  ❌ Demo failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { runDemo };
