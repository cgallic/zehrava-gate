#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);

// Parse --port, --data-dir, --policy-dir flags
let port = 4000;
let dataDir = './data';
let policyDir = './policies';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10);
  if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[i + 1];
  if (args[i] === '--policy-dir' && args[i + 1]) policyDir = args[i + 1];
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
  zehrava-gate — commit checkpoint for AI agents

  Usage:
    npx zehrava-gate [options]

  Options:
    --port <number>       Port to listen on (default: 4000)
    --data-dir <path>     SQLite data directory (default: ./data)
    --policy-dir <path>   Policy YAML directory (default: ./policies)
    --help                Show this help

  Example:
    npx zehrava-gate --port 4000
    npx zehrava-gate --port 3001 --policy-dir ./my-policies

  Dashboard:  http://localhost:<port>/dashboard
  Docs:       https://zehrava.com
    `);
    process.exit(0);
  }
}

process.env.PORT = String(port);
process.env.DATA_DIR = dataDir;
process.env.POLICY_DIR = policyDir;

console.log(`\n  Zehrava Gate v0.1.0`);
console.log(`  → Listening on http://localhost:${port}`);
console.log(`  → Data: ${dataDir}`);
console.log(`  → Policies: ${policyDir}`);
console.log(`  → Dashboard: http://localhost:${port}/dashboard\n`);

require('../src/index.js');
