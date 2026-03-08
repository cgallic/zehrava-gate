'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REGISTRY_PATH = process.env.REGISTRY_PATH ||
  path.join(__dirname, '../../config/destinations.yaml');

let registry = null;
let registryMtime = 0;

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  try {
    const stat = fs.statSync(REGISTRY_PATH);
    if (stat.mtimeMs === registryMtime && registry) return registry;
    registry = yaml.load(fs.readFileSync(REGISTRY_PATH, 'utf8')) || {};
    registryMtime = stat.mtimeMs;
    return registry;
  } catch (e) {
    console.error('[proxy:registry] Failed to load destinations.yaml:', e.message);
    return registry || {};
  }
}

/**
 * Look up destination config for a given hostname + path.
 * Returns { destination, policy, require_approval, passthrough, block, extract_records }
 * or null if the registry is empty.
 */
function lookup(hostname, urlPath) {
  const reg = loadRegistry();

  // Exact hostname match first
  let entry = reg[hostname];

  // Strip port from hostname if present
  if (!entry && hostname.includes(':')) {
    entry = reg[hostname.split(':')[0]];
  }

  if (!entry) {
    // Fall back to __default__
    entry = reg['__default__'] || { block: false };
  }

  if (entry.passthrough) return { passthrough: true };
  if (entry.block && !entry.destination) return { block: true };

  // Check path-specific overrides
  if (entry.paths && urlPath) {
    for (const [pathPrefix, pathConfig] of Object.entries(entry.paths)) {
      if (urlPath === pathPrefix || urlPath.startsWith(pathPrefix + '/') || urlPath.startsWith(pathPrefix + '?')) {
        return {
          destination: pathConfig.destination || entry.destination,
          policy: pathConfig.policy || entry.policy,
          require_approval: pathConfig.require_approval || entry.require_approval,
          extract_records: entry.extract_records,
          block: pathConfig.block || entry.block || false,
        };
      }
    }
  }

  return {
    destination: entry.destination,
    policy: entry.policy,
    require_approval: entry.require_approval,
    extract_records: entry.extract_records,
    block: entry.block || false,
  };
}

/**
 * Try to extract record count from parsed JSON body using a dot-path expression.
 * e.g. "records.length" → body.records.length
 * Returns integer or undefined.
 */
function extractRecordCount(body, expr) {
  if (!expr || !body) return undefined;
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const parts = expr.split('.');
    let val = parsed;
    for (const part of parts) {
      if (val == null) return undefined;
      val = part === 'length' ? (Array.isArray(val) ? val.length : undefined) : val[part];
    }
    return typeof val === 'number' ? val : undefined;
  } catch {
    return undefined;
  }
}

module.exports = { lookup, extractRecordCount, loadRegistry };
