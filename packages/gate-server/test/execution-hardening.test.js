/**
 * Execution-path hardening: who may request and report an execution, the
 * one-time token never leaking on reads, single-report outcomes, and signed
 * execution orders bound to the approved intent hash.
 *
 * Boots its own gate-server child process against an isolated, throwaway
 * DATA_DIR: `node test/execution-hardening.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39700 + (process.pid % 90);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-exec-hardening-test-'));

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

async function req(method, p, { body, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function main() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), PROXY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) console.error(d.toString()); });

  try {
    const start = Date.now();
    while (true) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
      if (Date.now() - start > 10000) throw new Error('Server did not become healthy in time');
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log('\n  Execution-path hardening');
    console.log('  ════════════════════════\n');

    const owner = (await req('POST', '/v1/agents/register', { body: { name: 'owner-agent' } })).body;
    const other = (await req('POST', '/v1/agents/register', { body: { name: 'other-agent' } })).body;
    const reviewer = (await req('POST', '/v1/agents/register', { body: { name: 'reviewer' } })).body;
    process.env.DATA_DIR = DATA_DIR;
    require('../src/lib/db').prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

    const propose = async () => (await req('POST', '/v1/intents', {
      bearer: owner.apiKey,
      body: { destination: 'salesforce.import', policy: 'crm-low-risk', recordCount: 50, payload: `leads-${crypto.randomUUID()}.csv` },
    })).body;

    console.log('Only the proposer or a reviewer can request execution...');
    const intent = await propose();
    assert(intent.status === 'approved', 'setup: low-risk intent auto-approved');
    const stranger = await req('POST', `/v1/intents/${intent.intentId}/execute`, { bearer: other.apiKey });
    assert(stranger.status === 403, 'another agent cannot request execution (and so never receives the token)');
    const exec = await req('POST', `/v1/intents/${intent.intentId}/execute`, { bearer: owner.apiKey });
    assert(exec.status === 201 && /^gex_/.test(exec.body.execution_token || ''), 'proposer gets the execution order and one-time token');
    const again = await req('POST', `/v1/intents/${intent.intentId}/execute`, { bearer: other.apiKey });
    assert(again.status === 403 && !again.body?.execution_token, 'a second request by another agent still cannot fetch the token');

    console.log('\nExecution orders are signed and bound to the approved intent...');
    {
      const order = exec.body.execution_order;
      assert(order?.execution_id === exec.body.execution_id && order.intent_id === intent.intentId, 'order names the execution and intent');
      assert(/^[0-9a-f]{64}$/.test(order.approved_intent_hash || ''), 'order carries the approved intent hash');
      assert(typeof exec.body.order_signature === 'string' && exec.body.order_signature.split('.').length === 3, 'order carries Gate\'s detached signature');
      const ok = await req('POST', '/v1/execution-orders/verify', { bearer: owner.apiKey, body: { execution_order: order, order_signature: exec.body.order_signature } });
      assert(ok.body?.valid === true && ok.body.matches_issued_order === true, 'verify endpoint accepts the issued order');
      const tampered = await req('POST', '/v1/execution-orders/verify', { bearer: owner.apiKey, body: { execution_order: { ...order, destination: 'stripe.payout' }, order_signature: exec.body.order_signature } });
      assert(tampered.body?.valid === false && tampered.body.signature_valid === false, 'an altered order fails verification');
    }

    console.log('\nThe token never leaks on reads...');
    {
      const read = await req('GET', `/v1/executions/${exec.body.execution_id}`, { bearer: other.apiKey });
      assert(read.status === 200 && read.body.execution_token === undefined, 'GET /v1/executions/:id omits the execution token');
      assert(!!read.body.order_signature, 'but still shows the signed order');
    }

    console.log('\nOnly the token holder, proposer or a reviewer can report, once...');
    {
      const id = exec.body.execution_id;
      const strangerReport = await req('POST', `/v1/executions/${id}/report`, { bearer: other.apiKey, body: { status: 'succeeded' } });
      assert(strangerReport.status === 403, 'another agent\'s API key cannot report this execution');
      const wrongToken = await req('POST', `/v1/executions/${id}/report`, { bearer: 'gex_not_the_token', body: { status: 'succeeded' } });
      assert(wrongToken.status === 401, 'a wrong token is rejected');
      const viaBody = await req('POST', `/v1/executions/${id}/report`, { body: { status: 'succeeded', execution_token: exec.body.execution_token, result: { ok: true } } });
      assert(viaBody.status === 200 && viaBody.body.status === 'succeeded', 'token in the body (as gate_exec sends it) reports the outcome');
      assert(viaBody.body.execution_token === undefined, 'the report response does not echo the token');
      const rewrite = await req('POST', `/v1/executions/${id}/report`, { bearer: exec.body.execution_token, body: { status: 'failed' } });
      assert(rewrite.status === 409 && rewrite.body.error === 'execution_already_reported', 'a reported outcome cannot be rewritten');
    }

    console.log('\nProposer and reviewer API keys still work for their own executions...');
    {
      const second = await propose();
      const e2 = (await req('POST', `/v1/intents/${second.intentId}/execute`, { bearer: reviewer.apiKey })).body;
      const byOwner = await req('POST', `/v1/executions/${e2.execution_id}/report`, { bearer: owner.apiKey, body: { status: 'succeeded' } });
      assert(byOwner.status === 200, 'the proposing agent can report with its API key');
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
