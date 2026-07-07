const dashboard = require('./dashboard');
const kaicalls = require('./kaicalls');
const noop = require('./noop');

// Approval provider abstraction (see issue #7): Gate decides a human is
// needed and always captures the decision itself via its own approve/
// reject/approval-link endpoints. A provider's only job is delivering the
// AUTHORIZE notification over some external channel — it never becomes
// the source of truth for the decision.
const PROVIDERS = { dashboard, kaicalls, noop };

function getApprovalProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown approval provider: ${name}`);
  return provider;
}

function listApprovalProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = { getApprovalProvider, listApprovalProviders, PROVIDERS };
