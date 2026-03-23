/**
 * Basic tests for Run Ledger
 * 
 * Run with: node src/lib/runs/test.js
 */

const assert = require('assert');
const db = require('../db');
const { generateApiKey, hashApiKey } = require('../crypto');
const RunLedger = require('./ledger');
const CheckpointSealer = require('./checkpoint');
const ResumeResolver = require('./resume');
const { EVENT_TYPES, SIDE_EFFECT_CLASS, RUN_STATUS } = require('./constants');
const { hashObject, sideEffectKey } = require('./hash');

// Create test agents
function createTestAgent(agentId) {
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, api_key_hash, risk_tier, created_at)
    VALUES (?, ?, ?, 'standard', ?)
  `).run(agentId, agentId, keyHash, Date.now());
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

console.log('\n  Run Ledger Tests');
console.log('  ════════════════\n');

// Create test agents
for (let i = 1; i <= 10; i++) {
  createTestAgent(`test-agent-${i}`);
}
createTestAgent('test-agent');
createTestAgent('salesforce-worker');

// Test 1: Start a run
test('RunLedger.start() creates a new run', () => {
  const run = RunLedger.start({
    agentId: 'test-agent',
    intentSummary: 'Test run',
    runtime: 'test-runtime',
    permissions: { allowed_tools: ['test'] }
  });
  
  assert(run.runId, 'runId should be set');
  assert(run.ledgerId, 'ledgerId should be set');
  assert.strictEqual(run.status, RUN_STATUS.ACTIVE, 'status should be active');
  
  const ledger = RunLedger.getRun(run.runId);
  assert(ledger, 'ledger should be retrievable');
  assert.strictEqual(ledger.run_id, run.runId);
});

// Test 2: Record events
test('RunLedger.recordEvent() records events in sequence', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-2',
    intentSummary: 'Test events',
    runtime: 'test-runtime'
  });
  
  const event1 = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.PLAN_LOCKED,
    payload: { steps: ['a', 'b'] }
  });
  
  const event2 = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.TOOL_CALL_STARTED,
    payload: { tool: 'test' }
  });
  
  assert.strictEqual(event1.seq, 2, 'first recorded event should be seq 2 (after run_started)');
  assert.strictEqual(event2.seq, 3, 'second event should be seq 3');
  
  const events = RunLedger.getEvents(run.ledgerId);
  assert.strictEqual(events.length, 3, 'should have 3 events (run_started + 2)');
});

// Test 3: Side effect deduplication
test('Side effect deduplication works', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-3',
    intentSummary: 'Test side effects',
    runtime: 'test-runtime'
  });
  
  const key = sideEffectKey('test_action', 'test_target', { data: 'test' });
  
  RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.TOOL_CALL_FINISHED,
    payload: { result: 'success' },
    sideEffectClass: SIDE_EFFECT_CLASS.EXTERNAL_MUTATION,
    sideEffectKey: key
  });
  
  const hasSideEffect = RunLedger.hasSideEffect(run.ledgerId, key);
  assert.strictEqual(hasSideEffect, true, 'should detect existing side effect');
  
  const otherKey = sideEffectKey('other_action', 'test_target', { data: 'test' });
  const hasOther = RunLedger.hasSideEffect(run.ledgerId, otherKey);
  assert.strictEqual(hasOther, false, 'should not detect non-existent side effect');
});

// Test 4: Checkpoint creation
test('CheckpointSealer.seal() creates valid checkpoints', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-4',
    intentSummary: 'Test checkpoints',
    runtime: 'test-runtime'
  });
  
  const event = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.PLAN_LOCKED,
    payload: { steps: ['a'] }
  });
  
  const checkpoint = CheckpointSealer.seal({
    ledgerId: run.ledgerId,
    eventId: event.eventId,
    reason: 'test'
  });
  
  assert(checkpoint.checkpointId, 'checkpoint should have ID');
  assert(checkpoint.sealedHash, 'checkpoint should have sealed hash');
  assert.strictEqual(checkpoint.isResumable, true, 'checkpoint should be resumable');
});

// Test 5: Checkpoint verification
test('CheckpointSealer.verify() validates integrity', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-5',
    intentSummary: 'Test verification',
    runtime: 'test-runtime'
  });
  
  const event = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.PLAN_LOCKED,
    payload: { steps: ['a'] }
  });
  
  const checkpoint = CheckpointSealer.seal({
    ledgerId: run.ledgerId,
    eventId: event.eventId,
    reason: 'test'
  });
  
  const verification = CheckpointSealer.verify(checkpoint.checkpointId);
  assert.strictEqual(verification.valid, true, 'checkpoint should verify successfully');
});

// Test 6: Resume from checkpoint
test('ResumeResolver.resume() loads valid resume context', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-6',
    intentSummary: 'Test resume',
    runtime: 'test-runtime'
  });
  
  // Record some events
  RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.PLAN_LOCKED,
    payload: { steps: ['fetch', 'process'] }
  });
  
  const toolEvent = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.TOOL_CALL_FINISHED,
    payload: { tool: 'fetch', records: 100 },
    sideEffectClass: SIDE_EFFECT_CLASS.EXTERNAL_MUTATION,
    sideEffectKey: sideEffectKey('fetch', 'db', { batch: 'test' })
  });
  
  const intEvent = RunLedger.recordEvent({
    ledgerId: run.ledgerId,
    eventType: EVENT_TYPES.INTERRUPTION_DETECTED,
    payload: { reason: 'test' }
  });
  
  // Create checkpoint
  CheckpointSealer.seal({
    ledgerId: run.ledgerId,
    eventId: intEvent.eventId,
    reason: 'interruption'
  });
  
  // Resume
  const resumeContext = ResumeResolver.resume(run.runId);
  
  assert(resumeContext.runId, 'resume context should have runId');
  assert(resumeContext.checkpointId, 'resume context should have checkpointId');
  assert(resumeContext.receipts.length > 0, 'should have receipts');
  assert(resumeContext.blockedSideEffectKeys.size > 0, 'should have blocked side effects');
});

// Test 7: Hash canonicalization
test('hashObject() produces stable hashes', () => {
  const obj1 = { b: 2, a: 1, c: { y: 4, x: 3 } };
  const obj2 = { a: 1, b: 2, c: { x: 3, y: 4 } };
  const obj3 = { a: 1, b: 2, c: { x: 3, y: 5 } };
  
  const hash1 = hashObject(obj1);
  const hash2 = hashObject(obj2);
  const hash3 = hashObject(obj3);
  
  assert.strictEqual(hash1, hash2, 'identical objects with different key order should hash the same');
  assert.notStrictEqual(hash1, hash3, 'different objects should hash differently');
});

// Test 8: Artifact creation
test('RunLedger.createArtifact() stores artifacts', () => {
  const run = RunLedger.start({
    agentId: 'test-agent-7',
    intentSummary: 'Test artifacts',
    runtime: 'test-runtime'
  });
  
  const artifact = RunLedger.createArtifact({
    ledgerId: run.ledgerId,
    artifactType: 'csv',
    uriOrPath: './test.csv',
    contentHash: 'abc123',
    metadata: { rows: 100 }
  });
  
  assert(artifact.artifactId, 'artifact should have ID');
  
  const artifacts = RunLedger.getArtifacts(run.ledgerId);
  assert.strictEqual(artifacts.length, 1, 'should have one artifact');
  assert.strictEqual(artifacts[0].artifact_type, 'csv');
});

console.log('\n  All tests passed! ✅\n');
