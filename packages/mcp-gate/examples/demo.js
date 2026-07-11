#!/usr/bin/env node
// Local demo of the full loop the Gate MCP tools drive:
//   propose -> approve -> execute -> result/audit
//
// Boots a throwaway gate-server, uses the tool handlers directly (same
// functions the MCP server calls, minus the stdio transport) to propose
// and wait for a human decision, approves it from a separate "reviewer"
// role to simulate a human clicking approve in the dashboard, then reports
// a result and reads back the audit trail.
//
// Run: node examples/demo.js

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { authorizeAction, sendResult, getAudit } from '../src/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_SERVER_ROOT = path.join(__dirname, '..', '..', 'gate-server');
const PORT = 3901;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mcp-demo-'));

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gate-server did not start in time');
}

async function raw(method, p, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return res.json();
}

async function main() {
  console.log('Starting local gate-server...');
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: GATE_SERVER_ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    await waitForHealth();

    const agent = await raw('POST', '/v1/agents/register', { body: { name: 'demo-agent' } });
    const reviewer = await raw('POST', '/v1/agents/register', { body: { name: 'demo-reviewer' } });

    process.env.DATA_DIR = DATA_DIR;
    const { default: db } = await import('../../gate-server/src/lib/db.js');
    db.prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

    const config = { endpoint: BASE, apiKey: agent.apiKey };

    console.log('\n1. gate_authorize_action: propose a refund and wait for a human decision...');
    const authorizePromise = authorizeAction({
      destination: 'stripe.refund',
      policy: 'finance-high-risk-assurance-demo',
      payload: 'refund.json',
      estimated_value_usd: 42,
      profile: 'payment.refund.v1',
      metadata: { amount_usd: 42, reason: 'customer requested' },
      poll_interval_ms: 300,
      timeout_ms: 15000,
    }, config);

    console.log('   (waiting for a human to approve — simulating that now)');
    await new Promise((r) => setTimeout(r, 500));
    const { proposals } = await raw('GET', '/v1/proposals?status=pending_approval', { apiKey: reviewer.apiKey });
    const target = proposals[0];
    await raw('POST', `/v1/intents/${target.id}/approve`, { apiKey: reviewer.apiKey, body: {} });

    const authorized = await authorizePromise;
    console.log(`   -> status: ${authorized.status}, execution token issued: ${!!authorized.execution?.execution_token}`);

    console.log('\n2. gate_send_result: report the outcome...');
    const reported = await sendResult({
      execution_id: authorized.execution.executionId,
      execution_token: authorized.execution.execution_token,
      status: 'succeeded',
      result: { refund_id: 're_demo_123' },
    }, config);
    console.log(`   -> execution status: ${reported.status}`);

    console.log('\n3. gate_get_audit: read back the audit trail + evidence bundle...');
    const audit = await getAudit({ intent_id: authorized.intentId }, config);
    console.log(`   -> ${audit.events.length} audit events, evidence decision: ${audit.approval_evidence?.decision}`);

    console.log('\nDemo complete.');
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});
