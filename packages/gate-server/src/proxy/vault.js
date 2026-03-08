'use strict';

/**
 * Gate V3 — Credential Vault
 *
 * Fetches credentials from configured provider at execution time.
 * Credentials are never logged, stored in DB, or returned to agents.
 * Each fetch is ephemeral — retrieved, used, discarded.
 *
 * Providers: env | 1password | hashicorp | aws
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VAULT_PATH = process.env.VAULT_CONFIG ||
  path.join(__dirname, '../../config/vault.yaml');

let _config = null;
let _opClient = null;  // 1Password SDK client (lazy-initialized)

function loadConfig() {
  if (_config) return _config;
  if (!fs.existsSync(VAULT_PATH)) {
    console.log('[vault] No vault.yaml found — gate_exec mode disabled');
    return null;
  }
  _config = yaml.load(fs.readFileSync(VAULT_PATH, 'utf8'));
  return _config;
}

// ── 1Password provider ──────────────────────────────────────────────────────

async function init1PasswordClient(cfg) {
  if (_opClient) return _opClient;
  const { createClient } = require('@1password/sdk');
  const tokenEnv = cfg['1password']?.service_account_token_env || 'OP_SERVICE_ACCOUNT_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`[vault:1password] ${tokenEnv} not set`);
  _opClient = await createClient({
    auth: token,
    integrationName: 'Zehrava Gate',
    integrationVersion: '0.3.0',
  });
  console.log('[vault:1password] Client initialized');
  return _opClient;
}

async function fetchFrom1Password(ref, cfg) {
  const client = await init1PasswordClient(cfg);
  // ref format: "op://vault/item/field"
  const secret = await client.secrets.resolve(ref);
  return secret;
}

// ── HashiCorp Vault provider ────────────────────────────────────────────────

async function fetchFromHashicorp(secretPath, cfg) {
  const https = require('https');
  const hcCfg = cfg.hashicorp;
  const address = hcCfg?.address || process.env.VAULT_ADDR || 'http://127.0.0.1:8200';

  // AppRole login
  const roleId   = process.env[hcCfg?.role_id_env   || 'VAULT_ROLE_ID'];
  const secretId = process.env[hcCfg?.secret_id_env || 'VAULT_SECRET_ID'];

  const loginResp = await httpPost(`${address}/v1/auth/approle/login`,
    JSON.stringify({ role_id: roleId, secret_id: secretId }),
    { 'Content-Type': 'application/json' }
  );
  const token = JSON.parse(loginResp).auth?.client_token;
  if (!token) throw new Error('[vault:hashicorp] AppRole login failed');

  const secretResp = await httpGet(
    `${address}/v1/${hcCfg?.mount || 'secret'}/data/${secretPath}`,
    { 'X-Vault-Token': token }
  );
  const data = JSON.parse(secretResp).data?.data;
  // Return first value in the secret
  return data ? Object.values(data)[0] : null;
}

// ── AWS Secrets Manager provider ────────────────────────────────────────────

async function fetchFromAWS(secretName, cfg) {
  // Uses AWS SDK v3 if available, falls back to direct API call
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: cfg.aws?.region || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    return resp.SecretString || Buffer.from(resp.SecretBinary, 'base64').toString();
  } catch (e) {
    throw new Error(`[vault:aws] ${e.message}`);
  }
}

// ── Simple HTTP helpers (no extra deps) ─────────────────────────────────────

function httpGet(url, headers) {
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    mod.get(url, { headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function httpPost(url, body, headers) {
  const mod = url.startsWith('https') ? require('https') : require('http');
  const parsed = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    const req = mod.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main: fetch credential for destination ──────────────────────────────────

async function fetchCredential(destination) {
  const cfg = loadConfig();
  if (!cfg) return null;

  const credDef = cfg.credentials?.[destination];
  if (!credDef) return null;

  const provider = cfg.provider || 'env';

  let secret;

  if (provider === 'env') {
    const envVar = credDef.secret_env;
    if (!envVar) throw new Error(`[vault] No secret_env defined for destination: ${destination}`);
    secret = process.env[envVar];
    if (!secret) {
      console.warn(`[vault] ENV var ${envVar} not set for ${destination} — gate_exec skipped`);
      return null;
    }
  } else if (provider === '1password') {
    const ref = credDef.ref || credDef.secret_1password;
    if (!ref) throw new Error(`[vault:1password] No ref defined for destination: ${destination}`);
    secret = await fetchFrom1Password(ref, cfg);
  } else if (provider === 'hashicorp') {
    const secretPath = credDef.secret_path || credDef.secret_hashicorp;
    if (!secretPath) throw new Error(`[vault:hashicorp] No secret_path for: ${destination}`);
    secret = await fetchFromHashicorp(secretPath, cfg);
  } else if (provider === 'aws') {
    const secretName = credDef.secret_name || credDef.secret_aws;
    if (!secretName) throw new Error(`[vault:aws] No secret_name for: ${destination}`);
    secret = await fetchFromAWS(secretName, cfg);
  } else {
    throw new Error(`[vault] Unknown provider: ${provider}`);
  }

  return { secret, credDef };
}

/**
 * Build auth headers for an HTTP request based on inject type.
 * Returns { headers, url } — url may change if inject=url.
 */
function buildAuth(secret, credDef, baseUrl) {
  const inject = credDef.inject || 'header';
  const headers = {};
  let url = baseUrl;

  if (inject === 'header') {
    const format = credDef.header_format || 'Bearer {secret}';
    const headerName = credDef.header_name || 'Authorization';
    headers[headerName] = format.replace('{secret}', secret);
  } else if (inject === 'basic_auth') {
    // Standard HTTP Basic: base64(secret:)
    const encoded = Buffer.from(`${secret}:`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  } else if (inject === 'query_param') {
    const paramName = credDef.query_param_name || 'api_key';
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${paramName}=${encodeURIComponent(secret)}`;
  } else if (inject === 'url') {
    // Credential IS the URL (e.g. Slack webhook)
    url = secret.replace('{secret}', secret);
  }

  return { headers, url };
}

function getExecuteConfig(destination) {
  const cfg = loadConfig();
  return cfg?.credentials?.[destination]?.execute || null;
}

function hasCredential(destination) {
  const cfg = loadConfig();
  return !!(cfg?.credentials?.[destination]);
}

module.exports = { fetchCredential, buildAuth, getExecuteConfig, hasCredential, loadConfig };
