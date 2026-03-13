#!/usr/bin/env node
'use strict';

const pkg = require('../package.json');
const args = process.argv.slice(2);
const subcommand = args[0];

// ─── HELP ───────────────────────────────────────────────────────────────────
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  zehrava-gate v${pkg.version} — write-path control plane for AI agents

  Usage:
    npx zehrava-gate [options]      Start the Gate server
    npx zehrava-gate demo           Run an interactive demo (no config required)

  Server options:
    --port <number>       Port to listen on (default: 4000)
    --data-dir <path>     SQLite data directory (default: ./data)
    --policy-dir <path>   Policy YAML directory (default: ./policies)
    --help                Show this help

  Examples:
    npx zehrava-gate --port 4000
    npx zehrava-gate --port 3001 --policy-dir ./my-policies
    npx zehrava-gate demo

  Dashboard:  http://localhost:<port>/dashboard
  Docs:       https://zehrava.com/docs
  `);
  process.exit(0);
}

// ─── DEMO SUBCOMMAND ────────────────────────────────────────────────────────
if (subcommand === 'demo') {
  runDemo();
} else {
  runServer();
}

// ─── SERVER ─────────────────────────────────────────────────────────────────
function runServer () {
  let port = 4000;
  let dataDir = './data';
  let policyDir = './policies';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10);
    if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[i + 1];
    if (args[i] === '--policy-dir' && args[i + 1]) policyDir = args[i + 1];
  }

  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  process.env.POLICY_DIR = policyDir;

  console.log(`\n  Zehrava Gate v${pkg.version}`);
  console.log(`  → Listening on http://localhost:${port}`);
  console.log(`  → Data: ${dataDir}`);
  console.log(`  → Policies: ${policyDir}`);
  console.log(`  → Dashboard: http://localhost:${port}/dashboard\n`);

  require('../src/index.js');
}

// ─── DEMO ────────────────────────────────────────────────────────────────────
async function runDemo () {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const http = require('http');

  const RESET  = '\x1b[0m';
  const BOLD   = '\x1b[1m';
  const DIM    = '\x1b[2m';
  const GREEN  = '\x1b[32m';
  const RED    = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const CYAN   = '\x1b[36m';
  const PURPLE = '\x1b[35m';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const line = (s = '') => console.log(s);
  const dim  = s => `${DIM}${s}${RESET}`;
  const bold = s => `${BOLD}${s}${RESET}`;
  const grn  = s => `${GREEN}${s}${RESET}`;
  const red  = s => `${RED}${s}${RESET}`;
  const ylw  = s => `${YELLOW}${s}${RESET}`;
  const cyn  = s => `${CYAN}${s}${RESET}`;
  const pur  = s => `${PURPLE}${s}${RESET}`;

  // Spinner
  function spinner (label) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0;
    const iv = setInterval(() => {
      process.stdout.write(`\r  ${CYAN}${frames[i++ % frames.length]}${RESET} ${label}`);
    }, 80);
    return { stop (final) { clearInterval(iv); process.stdout.write(`\r  ${final}\n`); } };
  }

  // HTTP helper
  function post (port, path, body, key) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(key ? { 'Authorization': `Bearer ${key}` } : {}) }
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  function get (port, path, key) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path, method: 'GET',
        headers: { ...(key ? { 'Authorization': `Bearer ${key}` } : {}) }
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── Setup temp dirs ──
  const demoDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'zehrava-gate-demo-'));
  const dataDir  = path.join(demoDir, 'data');
  const polDir   = path.join(demoDir, 'policies');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(polDir);

  // Write demo policies
  fs.writeFileSync(path.join(polDir, 'support-reply.yaml'), [
    'id: support-reply',
    'destinations: [zendesk.reply, intercom.reply]',
    'auto_approve_under: 5',
    'block_if_terms: ["refund guaranteed", "legal action", "compensation"]',
    'expiry_minutes: 30',
  ].join('\n'));

  fs.writeFileSync(path.join(polDir, 'finance-high-risk.yaml'), [
    'id: finance-high-risk',
    'destinations: [stripe.refund, quickbooks.journal]',
    'require_approval: always',
    'expiry_minutes: 15',
  ].join('\n'));

  // Pick a random port
  const port = 14000 + Math.floor(Math.random() * 1000);

  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  process.env.POLICY_DIR = polDir;
  process.env.GATE_DEMO = '1';  // suppress normal startup logs

  console.clear();
  line();
  console.log(`  ${PURPLE}${BOLD}Zehrava Gate${RESET} ${dim(`v${pkg.version}`)} — demo mode`);
  line(`  ${dim('Spinning up a temporary Gate server...')}`);
  line();

  // Start server quietly
  const sp = spinner('Starting server');
  const serverModule = require('../src/index.js');
  await sleep(1200);
  sp.stop(`${grn('✓')} Server ready on :${port}`);

  await sleep(300);

  // Register a demo agent
  const reg = await post(port, '/v1/agents/register', { name: 'demo-agent', riskTier: 'standard' });
  const key = reg.apiKey;

  line();
  line(`  ${bold('Three intents. Three outcomes.')}`);
  line(`  ${dim('─────────────────────────────────────────────')}`);

  // ── Intent 1: auto-approved ──
  await sleep(600);
  line();
  line(`  ${bold('Intent 1')} — Support reply  ${dim('policy: support-reply')}`);
  line(`  ${dim('Payload:')} "Your ticket is resolved. Thank you for your patience."`);

  const sp1 = spinner('Submitting to Gate...');
  await sleep(900);
  const i1 = await post(port, '/v1/intents', {
    payload: 'Your ticket is resolved. Thank you for your patience.',
    destination: 'zendesk.reply',
    policy: 'support-reply',
    recordCount: 1
  }, key);
  sp1.stop(`${grn('✓')} ${bold(grn('auto-approved'))}  ${dim(i1.intentId)}`);
  line(`     ${dim('→ record_count: 1 (under auto_approve_under: 5)')}`);

  // ── Intent 2: blocked ──
  await sleep(800);
  line();
  line(`  ${bold('Intent 2')} — Support reply with blocked term  ${dim('policy: support-reply')}`);
  line(`  ${dim('Payload:')} "A refund guaranteed — no questions asked."`);

  const sp2 = spinner('Submitting to Gate...');
  await sleep(900);
  const i2 = await post(port, '/v1/intents', {
    payload: 'A refund guaranteed — no questions asked.',
    destination: 'zendesk.reply',
    policy: 'support-reply',
    recordCount: 1
  }, key);
  sp2.stop(`${red('✗')} ${bold(red('blocked'))}  ${dim(i2.intentId || i2.message)}`);
  if (i2.blockReason) line(`     ${dim('→ reason:')} ${ylw(i2.blockReason)}`);

  // ── Intent 3: pending approval ──
  await sleep(800);
  line();
  line(`  ${bold('Intent 3')} — Stripe refund  ${dim('policy: finance-high-risk')}`);
  line(`  ${dim('Payload:')} "Refund $349.00 for order #ORD-7821"`);

  const sp3 = spinner('Submitting to Gate...');
  await sleep(900);
  const i3 = await post(port, '/v1/intents', {
    payload: 'Refund $349.00 for order #ORD-7821',
    destination: 'stripe.refund',
    policy: 'finance-high-risk',
    recordCount: 1
  }, key);
  sp3.stop(`${ylw('⏸')} ${bold(ylw('pending_approval'))}  ${dim(i3.intentId)}`);
  line(`     ${dim('→ policy require_approval: always — waiting for human review')}`);

  // ── Audit trail ──
  await sleep(600);
  line();
  line(`  ${dim('─────────────────────────────────────────────')}`);
  line(`  ${bold('Audit trail for intent 1')}  ${dim('(' + (i1.intentId || '') + ')')}`);

  if (i1.intentId) {
    const audit = await get(port, `/v1/intents/${i1.intentId}/audit`, key);
    if (Array.isArray(audit.events)) {
      audit.events.forEach(ev => {
        const type = ev.event_type || ev.event || 'unknown';
        const time = ev.created_at || ev.timestamp;
        const ts = time ? new Date(time).toISOString().substr(11,8) : '';
        line(`  ${dim('→')} ${cyn(type.padEnd(24))} ${dim(ts)}`);
      });
    }
  }

  // ── Metrics ──
  const m = await get(port, '/v1/metrics', key);
  line();
  line(`  ${bold('Metrics')}`);
  line(`  ${dim('approved:')}  ${grn(String(m.actions_approved))}   ${dim('blocked:')}  ${red(String(m.actions_blocked))}   ${dim('pending:')}  ${ylw(String(m.actions_pending))}`);

  line();
  line(`  ${dim('─────────────────────────────────────────────')}`);
  line(`  ${bold('Try it yourself')}`);
  line();
  line(`  ${dim('Install:')}    ${cyn('npm install zehrava-gate')}`);
  line(`  ${dim('Start:')}      ${cyn(`npx zehrava-gate --port 4000`)}`);
  line(`  ${dim('Docs:')}       ${cyn('https://zehrava.com/docs')}`);
  line(`  ${dim('Dashboard:')}  ${cyn('https://zehrava.com/dashboard')}`);
  line();

  // Cleanup
  fs.rmSync(demoDir, { recursive: true, force: true });
  process.exit(0);
}
