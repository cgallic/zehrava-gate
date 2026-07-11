// Thin HTTP client over the Gate REST API. No business logic lives here —
// tools.js owns the mapping from MCP tool call to Gate endpoint(s); this
// module only knows how to authenticate and shape a request/response.

function resolveConfig(overrides = {}) {
  return {
    endpoint: (overrides.endpoint || process.env.GATE_ENDPOINT || 'http://localhost:3001').replace(/\/$/, ''),
    apiKey: overrides.apiKey || process.env.GATE_API_KEY || null,
  };
}

async function gateRequest(method, path, { body, config, bearerOverride } = {}) {
  const { endpoint, apiKey } = resolveConfig(config);
  const token = bearerOverride || apiKey;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response body — leave json as null, callers check res.ok/status.
  }

  return { ok: res.ok, status: res.status, body: json };
}

export { gateRequest, resolveConfig };
