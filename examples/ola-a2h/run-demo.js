#!/usr/bin/env node
/**
 * Gate + Ola, end to end, on your laptop.
 *
 *   node examples/ola-a2h/run-demo.js             # the human approves in the terminal
 *   node examples/ola-a2h/run-demo.js --browser   # the human approves on the gateway's page
 *
 * 1. Starts a local A2H v1.0 gateway (mock-gateway.js, standing in for Twilio Ola).
 * 2. Starts Gate with policies/ola-refunds.yaml (refunds need a signed human answer).
 * 3. A refund agent proposes a $450 refund. Gate's policy holds it and sends
 *    an A2H AUTHORIZE to the gateway.
 * 4. The human approves. The gateway signs the RESPONSE (HMAC webhook + ES256
 *    JWS); Gate verifies both, binds the answer to the exact intent, and only
 *    then issues a one-time execution order.
 * 5. A second refund is declined — Gate blocks it for good.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { createMockGateway } = require('./mock-gateway');

const GATE_PORT = Number(process.env.GATE_PORT || 4000);
const GATEWAY_PORT = 4100; // must match gateway_url in policies/ola-refunds.yaml
const GATE = `http://localhost:${GATE_PORT}`;
const API_KEY = 'a2h_demo_key';
const BROWSER = process.argv.includes('--browser');
const SERVER_DIR = path.join(__dirname, '../../packages/gate-server');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const accent = (s) => `\x1b[38;5;105m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, { body, apiKey } = {}) {
  const res = await fetch(`${GATE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function until(fn, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timed out');
}

// One reader for the whole run; with no terminal attached (CI, piped
// input) the scripted decision is used instead of prompting.
let rl = null;
function ask(question) {
  if (!process.stdin.isTTY) { console.log(question); return Promise.resolve(''); }
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const gateway = await createMockGateway({ port: GATEWAY_PORT, apiKey: API_KEY, log: (m) => console.log(dim(`   [ola] ${m}`)) });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ola-demo-'));
  const gate = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(GATE_PORT),
      BASE_URL: GATE,
      DATA_DIR: dataDir,
      POLICY_DIR: path.join(__dirname, 'policies'),
      A2H_GATEWAY_API_KEY: API_KEY,
      GATE_PROVIDER_SECRET_A2H: 'whsec_ola_demo_callback_secret',
      PROXY_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const shutdown = async () => { rl?.close(); gate.kill(); await gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  process.on('SIGINT', () => shutdown().then(() => process.exit(130)));

  try {
    await until(async () => { try { return (await fetch(`${GATE}/health`)).ok; } catch { return false; } }, 15_000);
    console.log(`\n${bold('Zehrava Gate + Twilio Ola (A2H v1.0)')}`);
    console.log(dim(`Gate ${GATE} · A2H gateway ${gateway.url}\n`));

    const agent = (await api('POST', '/v1/agents/register', { body: { name: 'refund-agent' } })).body;
    const reviewer = (await api('POST', '/v1/agents/register', { body: { name: 'ops-reviewer' } })).body;
    process.env.DATA_DIR = dataDir;
    require(path.join(SERVER_DIR, 'src/lib/db')).prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

    for (const [n, amount, scripted] of [[1, 450, 'APPROVE'], [2, 9800, 'DECLINE']]) {
      console.log(`${accent(`■ Refund #${n}`)} — agent proposes a $${amount} Stripe refund`);
      const proposed = (await api('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: {
          destination: 'stripe.refund', policy: 'ola-refunds', action: `refund $${amount} to cus_4821`,
          payload: `refund-${n}.json`, estimated_value_usd: amount, principal_id: 'did:example:ops-lead',
        },
      })).body;
      console.log(`  Gate: ${bold(proposed.status)} · risk ${proposed.riskLevel} · needs ${JSON.stringify(proposed.requiredApprovalFactors)}`);

      const rec = await until(() => gateway.interactionForMessage(proposed.messageId));
      console.log(`  Gate → Ola: A2H AUTHORIZE ${dim(`(message_id ${proposed.messageId}, ttl ${rec.message.ttl_sec}s, to ${rec.message.channel?.address})`)}`);

      if (BROWSER) {
        console.log(`  ${bold('Open')} ${gateway.url}/approve/${rec.id} ${bold('and decide.')}`);
      } else {
        const answer = (await ask(`  The ops lead's phone buzzes: "${rec.message.render.body}"  ${bold(`[a]pprove / [d]ecline (default ${scripted === 'APPROVE' ? 'a' : 'd'})`)} `)).trim().toLowerCase();
        const decision = answer ? (answer.startsWith('a') ? 'APPROVE' : 'DECLINE') : scripted;
        await gateway.decide(rec.id, decision, { factor: 'passkey.webauthn.v1' });
      }

      const intent = await until(async () => {
        const i = (await api('GET', `/v1/intents/${proposed.intentId}`, { apiKey: reviewer.apiKey })).body;
        return i.approval_state !== 'waiting_input' && i.approval_state !== 'sent' ? i : null;
      }, BROWSER ? 15 * 60_000 : 30_000);
      const ev = intent.approval_interactions?.[0]?.evidence;
      console.log(`  Ola → Gate: signed RESPONSE via ${ev?.proof?.a2h?.transport} · verified ${JSON.stringify(ev?.factors)}`);
      console.log(`  Gate: ${bold(intent.status)}`);

      if (intent.status === 'approved') {
        const order = await api('POST', `/v1/intents/${proposed.intentId}/execute`, { apiKey: reviewer.apiKey });
        console.log(`  Gate: execution order issued ${dim(`(HTTP ${order.status}, one-time token, 15-minute TTL)`)} — your worker runs the refund`);
      } else {
        const order = await api('POST', `/v1/intents/${proposed.intentId}/execute`, { apiKey: reviewer.apiKey });
        console.log(`  Gate: execution refused ${dim(`(HTTP ${order.status})`)} — nothing moves`);
      }
      console.log('');
    }

    console.log(dim('Every step above is in Gate\'s audit ledger: GET /v1/audit/:intentId\n'));
  } finally {
    await shutdown();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
