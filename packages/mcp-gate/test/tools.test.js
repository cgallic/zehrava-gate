/**
 * Tests for the Gate MCP tool handlers (issue #9), exercised directly
 * (no MCP stdio transport in the loop) against a real gate-server child
 * process. Proves: no tool can execute a write without Gate's own
 * approval/execution-token pipeline agreeing to it, and the full
 * propose -> approve -> execute -> result/audit demo flow works.
 *
 * `node test/tools.test.js`
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { proposeIntent, authorizeAction, collectInput, sendResult, getStatus, getAudit } from '../src/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_SERVER_ROOT = path.join(__dirname, '..', '..', 'gate-server');
const PORT = 39000 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mcp-test-'));

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not become healthy in time');
}

async function raw(method, p, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function registerAgent(name) {
  const { body } = await raw('POST', '/v1/agents/register', { body: { name, riskTier: 'standard' } });
  return body;
}

function promoteToReviewer(agentId) {
  process.env.DATA_DIR = DATA_DIR;
  return import('../../gate-server/src/lib/db.js').then((mod) => {
    const db = mod.default;
    db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(agentId);
  });
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: GATE_SERVER_ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    await waitForHealth();
    console.log('\n  Gate MCP Tool Handler Tests (issue #9)');
    console.log('  ═══════════════════════════════════════════\n');

    const agent = await registerAgent('agent-mcp');
    const reviewer = await registerAgent('reviewer-mcp');
    await promoteToReviewer(reviewer.agentId);

    const config = { endpoint: BASE, apiKey: agent.apiKey };

    console.log('gate_propose_intent creates an intent without waiting for a decision...');
    let intentId;
    {
      const result = await proposeIntent({ destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads.csv' }, config);
      assert(result.httpStatus === 200, 'propose succeeds');
      assert(result.status === 'pending_approval', 'requires approval (over threshold)');
      intentId = result.intentId;
    }

    console.log('\ngate_get_status reflects the pending intent...');
    {
      const status = await getStatus({ intent_id: intentId }, config);
      assert(status.status === 'pending_approval', 'status matches');
      assert(status.approval_state === 'waiting_input', 'approval_state is waiting_input');
    }

    console.log('\ngate_send_result cannot report on an intent with no execution — nothing was authorized...');
    {
      // No execution ever existed for this intent — proves the MCP surface
      // has no side channel to fabricate one.
      const fakeExecId = 'exe_does_not_exist';
      const result = await sendResult({ execution_id: fakeExecId, status: 'succeeded', result: {} }, { ...config, apiKey: reviewer.apiKey });
      assert(result.httpStatus === 404, 'reporting against a nonexistent execution is refused');
    }

    console.log('\nFull demo loop: gate_authorize_action blocks until approved, then execution is available...');
    {
      const authorizePromise = authorizeAction({
        destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads-authorize.csv',
        poll_interval_ms: 200, timeout_ms: 10_000,
      }, config);

      // Simulate a human approving shortly after — read the intent id back
      // out via a short-lived propose call's own return isn't available
      // here since authorizeAction already issued it internally; instead
      // list pending proposals as a reviewer would from a dashboard.
      await new Promise((r) => setTimeout(r, 300));
      const { body: pendingList } = await raw('GET', '/v1/proposals?status=pending_approval', { apiKey: reviewer.apiKey });
      const target = pendingList.proposals.find((p) => p.payload_path === 'leads-authorize.csv');
      assert(!!target, 'the authorize call\'s intent is visible to a reviewer while pending');

      await raw('POST', `/v1/intents/${target.id}/approve`, { apiKey: reviewer.apiKey, body: {} });

      const authorized = await authorizePromise;
      assert(authorized.status === 'approved', 'gate_authorize_action returns once approved');
      assert(!authorized.timedOut, 'did not time out');
      assert(!!authorized.execution?.execution_token, 'an execution token was attached automatically on approval');

      const reported = await sendResult({
        execution_id: authorized.execution.executionId,
        execution_token: authorized.execution.execution_token,
        status: 'succeeded',
        result: { note: 'mcp demo' },
      }, config);
      assert(reported.httpStatus === 200, 'gate_send_result succeeds with the authorized execution token');
      assert(reported.status === 'succeeded', 'execution status reflects success');

      const audit = await getAudit({ intent_id: authorized.intentId }, config);
      assert(!!audit.approval_evidence, 'gate_get_audit includes the approval evidence bundle');
      assert(audit.approval_evidence.decision === 'APPROVE', 'evidence decision is APPROVE');
    }

    console.log('\ngate_authorize_action reports a blocked decision without ever authorizing execution...');
    {
      const authorizePromise = authorizeAction({
        destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads-reject.csv',
        poll_interval_ms: 200, timeout_ms: 10_000,
      }, config);

      await new Promise((r) => setTimeout(r, 300));
      const { body: pendingList } = await raw('GET', '/v1/proposals?status=pending_approval', { apiKey: reviewer.apiKey });
      const target = pendingList.proposals.find((p) => p.payload_path === 'leads-reject.csv');
      assert(!!target, 'the authorize call\'s intent (to be rejected) is visible to a reviewer while pending');
      await raw('POST', `/v1/intents/${target.id}/reject`, { apiKey: reviewer.apiKey, body: { reason: 'not needed' } });

      const authorized = await authorizePromise;
      assert(authorized.status === 'blocked', 'reports the blocked decision');
      assert(!authorized.execution, 'no execution object is present for a blocked decision');
    }

    console.log('\ngate_authorize_action times out cleanly when no decision arrives...');
    {
      const authorized = await authorizeAction({
        destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads-timeout.csv',
        poll_interval_ms: 200, timeout_ms: 600,
      }, config);
      assert(authorized.timedOut === true, 'times out rather than hanging or fabricating a decision');
      assert(authorized.status === 'pending_approval', 'reports the true still-pending status');
    }

    console.log('\ngate_collect_input reframes a rejection as a DECLINE decision with a response_text...');
    {
      const collectPromise = collectInput({
        destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 200, payload: 'leads-collect.csv',
        poll_interval_ms: 200, timeout_ms: 10_000,
      }, config);

      await new Promise((r) => setTimeout(r, 300));
      const { body: pendingList } = await raw('GET', '/v1/proposals?status=pending_approval', { apiKey: reviewer.apiKey });
      const target = pendingList.proposals.find((p) => p.payload_path === 'leads-collect.csv');
      assert(!!target, 'the collect-input call\'s intent is visible to a reviewer while pending');
      await raw('POST', `/v1/intents/${target.id}/reject`, { apiKey: reviewer.apiKey, body: { reason: 'ask again later' } });

      const collected = await collectPromise;
      assert(collected.decision === 'DECLINE', 'decision is DECLINE');
      assert(collected.responseText === 'ask again later', 'response_text carries the human-provided reason');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
