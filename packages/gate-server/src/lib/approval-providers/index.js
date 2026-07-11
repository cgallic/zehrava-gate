const dashboard = require('./dashboard');
const kaicalls = require('./kaicalls');
const a2h = require('./a2h');
const noop = require('./noop');

// Approval provider abstraction (see issue #7): Gate decides a human is
// needed and always captures the decision itself via its own approve/
// reject/approval-link endpoints (or, for providers that DO issue a signed
// decision, via the verified callback route from issue #14). A provider's
// job is delivering the AUTHORIZE notification over some external channel —
// it never becomes the source of truth for the decision unless its
// verifyResponse() actually cryptographically proves one.
const PROVIDERS = { dashboard, kaicalls, a2h, noop };

// Capability declarations (issue #12/#15): which approval factors a
// provider can plausibly produce evidence for. Used to reject policy/
// dispatch configs that ask a provider for a factor it can't deliver, and
// to enforce risk-tiered assurance requirements on inbound callbacks.
// Overridable per-deployment via GATE_PROVIDER_CAPABILITIES (JSON object,
// same shape as DEFAULT_CAPABILITIES) so operators can declare capabilities
// for custom providers without a code change.
const DEFAULT_CAPABILITIES = {
  dashboard: ['manual.dashboard.v1'],
  kaicalls: ['voice.ivr.v1', 'voice.spoken.v1', 'sms.otp.v1'],
  a2h: ['a2h.signed_response.v1'],
  noop: [],
};

function loadCapabilityOverrides() {
  if (!process.env.GATE_PROVIDER_CAPABILITIES) return {};
  try {
    return JSON.parse(process.env.GATE_PROVIDER_CAPABILITIES);
  } catch {
    return {};
  }
}

function getApprovalProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown approval provider: ${name}`);
  return provider;
}

function listApprovalProviders() {
  return Object.keys(PROVIDERS);
}

function getProviderCapabilities(name) {
  const overrides = loadCapabilityOverrides();
  if (overrides[name]) return overrides[name];
  return DEFAULT_CAPABILITIES[name] || [];
}

// True if `name` can satisfy every factor in requiredFactors. An unknown
// provider or a provider with no declared capabilities can only satisfy an
// empty requirement list — fails closed rather than assuming capability.
function providerSupportsFactors(name, requiredFactors = []) {
  if (!requiredFactors || requiredFactors.length === 0) return true;
  const capabilities = getProviderCapabilities(name);
  return requiredFactors.every((factor) => capabilities.includes(factor));
}

module.exports = {
  getApprovalProvider,
  listApprovalProviders,
  getProviderCapabilities,
  providerSupportsFactors,
  DEFAULT_CAPABILITIES,
  PROVIDERS,
};
