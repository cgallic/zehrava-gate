/**
 * A2H v1.0 conformance for the a2h (Twilio Ola) approval provider.
 *
 * Runs Gate against the spec-conformant mock gateway from
 * examples/ola-a2h/mock-gateway.js and checks the full wire contract from
 * https://github.com/twilio-labs/Agent2Human (a2h_framework.md):
 *   - AUTHORIZE envelope (§1.2/§1.3) and gateway auth headers (§1.8.3)
 *   - signed webhook RESPONSE (§1.12) incl. replay, bad/stale signatures
 *   - detached JWS over the JCS-canonical RESPONSE (§1.11.2)
 *   - status polling fallback (§1.12.9), fail-closed on unsigned polls
 *   - ERROR / expiry (§1.3), cancel propagation (§1.7), gateway auth failure
 * plus unit checks of the JCS/JWS helpers in lib/a2h-protocol.js.
 *
 * Boots its own gate-server child process against a throwaway DATA_DIR and
 * POLICY_DIR: `node test/a2h-spec-conformance.test.js`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createMockGateway } = require('../../../examples/ola-a2h/mock-gateway');
const protocol = require('../src/lib/a2h-protocol');

const ROOT = path.join(__dirname, '..');
const PORT = 39800 + (process.pid % 150);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-a2h-spec-test-'));
const POLICY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-a2h-spec-policies-'));
const CALLBACK_SECRET = 'whsec_test_a2h_spec';
const API_KEY = 'a2h_test_key';

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 6000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

async function req(method, p, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

function writePolicy(id, a2h, assurance) {
  const lines = [
    `id: ${id}`,
    'require_approval: always',
    'destinations: [stripe.refund]',
    'expiry_minutes: 15',
    'approval_channel:',
    '  provider: a2h',
    '  a2h:',
    ...Object.entries(a2h).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
  ];
  if (assurance) {
    lines.push('assurance:');
    for (const level of ['low', 'medium', 'high', 'critical']) lines.push(`  ${level}: ${JSON.stringify(assurance)}`);
  }
  fs.writeFileSync(path.join(POLICY_DIR, `${id}.yaml`), lines.join('\n') + '\n');
}

function protocolUnitChecks() {
  console.log('lib/a2h-protocol: JCS + detached JWS...');
  assert(protocol.canonicalize({ b: 2, a: [1, { d: true, c: null }], e: 'x' }) === '{"a":[1,{"c":null,"d":true}],"b":2,"e":"x"}', 'canonicalize sorts keys recursively with no whitespace');
  assert(protocol.canonicalize({ n: 1e21, m: 0.1 }) === '{"m":0.1,"n":1e+21}', 'canonicalize uses ES number formatting');

  const message = { type: 'RESPONSE', responds_to: 'm1', decision: 'APPROVE', evidence: { factor: 'push.v1' } };
  for (const [alg, gen] of [
    ['ES256', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })],
    ['RS256', () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })],
    ['EdDSA', () => crypto.generateKeyPairSync('ed25519')],
  ]) {
    const { privateKey, publicKey } = gen();
    const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: `k-${alg}` }] };
    const signed = { ...message, signature: protocol.signDetachedJws(message, privateKey, { alg, kid: `k-${alg}` }) };
    assert(protocol.verifyDetachedJws(signed, jwks).valid, `${alg} detached JWS round-trips`);
    const tampered = { ...signed, decision: 'DECLINE' };
    assert(protocol.verifyDetachedJws(tampered, jwks).reason === 'signature_invalid', `${alg}: changing a signed field invalidates the signature`);
  }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
  const signed = { ...message, signature: protocol.signDetachedJws(message, privateKey, { kid: 'k1' }) };
  assert(protocol.verifyDetachedJws(signed, { keys: [{ ...other.export({ format: 'jwk' }), kid: 'k1' }] }).valid === false, 'signature from a key not in the JWKS is rejected');
  assert(protocol.verifyDetachedJws(signed, { keys: [] }).reason === 'signature_key_not_found', 'empty JWKS fails closed');
  assert(protocol.verifyDetachedJws({ ...message, signature: 'eyJhbGciOiJub25lIn0..' }, { keys: [] }).reason === 'signature_alg_unsupported', 'alg "none" is rejected');

  const ep = protocol.resolveGatewayEndpoints('https://gw.example.com/');
  assert(ep.intent === 'https://gw.example.com/v1/intent' && ep.status('a b') === 'https://gw.example.com/v1/status/a%20b', 'base gateway_url resolves spec endpoints');
  const legacy = protocol.resolveGatewayEndpoints('https://gw.example.com/v1/authorize');
  assert(legacy.intent === 'https://gw.example.com/v1/authorize' && legacy.cancel('x') === 'https://gw.example.com/v1/cancel/x', 'explicit /v1/<path> gateway_url is honoured, status/cancel derive from base');
}

async function main() {
  protocolUnitChecks();

  const events = [];
  const gwSigned = await createMockGateway({ apiKey: API_KEY, signResponses: true, webhooks: true });
  const gwPollOnly = await createMockGateway({ apiKey: API_KEY, signResponses: false, webhooks: false });
  const gwOtherKey = await createMockGateway({ apiKey: 'a2h_some_other_key' });

  writePolicy('a2h-webhook', {
    gateway_url: gwSigned.url, gateway_id: 'mock-signed', agent_id: 'did:web:agent.test',
    channel: { type: 'sms', address: 'tel:+15555550100' }, jwks_uri: `${gwSigned.url}/.well-known/jwks.json`,
    poll: false, webhook: 'always',
  }, ['a2h.signed_response.v1']);
  writePolicy('a2h-jws-required', {
    gateway_url: gwSigned.url, jwks_uri: `${gwSigned.url}/.well-known/jwks.json`, require_jws: true, poll: false, webhook: 'always',
  }, ['a2h.jws.v1', 'passkey.webauthn.v1']);
  writePolicy('a2h-poll', { gateway_url: gwPollOnly.url, poll_interval_sec: 0.25, auth: 'bearer' });
  writePolicy('a2h-poll-strict', { gateway_url: gwPollOnly.url, poll_interval_sec: 0.25 }, ['a2h.signed_response.v1']);
  writePolicy('a2h-bad-key', { gateway_url: gwOtherKey.url });

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DATA_DIR, POLICY_DIR, PORT: String(PORT), BASE_URL: BASE, PROXY_API_KEY: '',
      A2H_GATEWAY_API_KEY: API_KEY, GATE_PROVIDER_SECRET_A2H: CALLBACK_SECRET, A2H_AGENT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { if (process.env.DEBUG) process.stdout.write(d); });
  server.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d); });

  try {
    const healthy = await waitFor(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 10000, 150);
    if (!healthy) throw new Error('Server did not become healthy in time');

    console.log('\n  A2H v1.0 Conformance (Twilio Ola)');
    console.log('  ══════════════════════════════════\n');

    const agent = (await req('POST', '/v1/agents/register', { body: { name: 'agent-a2h-spec', riskTier: 'standard' } })).body;
    const reviewer = (await req('POST', '/v1/agents/register', { body: { name: 'reviewer-a2h-spec', riskTier: 'standard' } })).body;
    process.env.DATA_DIR = DATA_DIR;
    require('../src/lib/db').prepare("UPDATE agents SET role = 'admin' WHERE id = ?").run(reviewer.agentId);

    const getIntent = async (id) => (await req('GET', `/v1/intents/${id}`, { apiKey: reviewer.apiKey })).body;
    const waitState = (id, state, ms) => waitFor(async () => { const i = await getIntent(id); return i?.approval_state === state ? i : null; }, ms);

    async function propose(policy, extra = {}) {
      const { status, body } = await req('POST', '/v1/intents', {
        apiKey: agent.apiKey,
        body: { destination: 'stripe.refund', policy, payload: `refund-${crypto.randomUUID()}.json`, estimated_value_usd: 120, principal_id: 'did:example:alice', ...extra },
      });
      if (status !== 200) throw new Error(`propose ${policy} failed: ${status} ${JSON.stringify(body)}`);
      return body;
    }
    const gatewayRecordFor = (gw, messageId) => waitFor(() => gw.interactionForMessage(messageId), 4000, 50);

    console.log('AUTHORIZE envelope matches the A2H v1.0 spec...');
    const a = await propose('a2h-webhook', { expiresIn: '10m' });
    const recA = await gatewayRecordFor(gwSigned, a.messageId);
    if (!recA) {
      const intent = await getIntent(a.intentId);
      throw new Error(`gateway never received the AUTHORIZE (approval_state=${intent?.approval_state}); see server log with DEBUG=1`);
    }
    {
      const m = recA?.message || {};
      const intake = gwSigned.requests.find((r) => r.path === '/v1/intent' && r.body?.message_id === a.messageId);
      assert(!!recA, 'gateway received the AUTHORIZE at POST /v1/intent');
      assert(m.a2h_version === '1.0' && m.a2h_min_version === '1.0' && m.type === 'AUTHORIZE', 'a2h_version 1.0 envelope with type AUTHORIZE');
      assert(m.message_id === a.messageId, 'message_id is the intent messageId (RESPONSE binds to it via responds_to)');
      assert(m.agent_id === 'did:web:agent.test' && m.principal_id === 'did:example:alice', 'agent_id from policy, principal_id from the intent');
      assert(m.channel?.type === 'sms' && m.channel?.address === 'tel:+15555550100' && !!m.channel?.render?.body, 'channel carries a URI address and render');
      assert(typeof m.render?.body === 'string' && m.render.body.length > 0, 'top-level render.body (read by the reference gateway)');
      assert(Number.isInteger(m.ttl_sec) && m.ttl_sec > 540 && m.ttl_sec <= 600, 'ttl_sec derived from the intent expiry (expiresIn: 10m)');
      assert(!Number.isNaN(Date.parse(m.created_at)), 'created_at is an ISO timestamp');
      assert(m.callback?.url === `${BASE}/v1/approval-callbacks/a2h`, 'callback.url points at Gate\'s A2H webhook');
      assert(m.callback?.secret === protocol.deriveCallbackSecret(CALLBACK_SECRET, a.messageId) && m.callback.secret !== CALLBACK_SECRET, 'callback.secret is derived per interaction — the master secret never leaves Gate');
      assert(m.params?.gate?.intent_id === a.intentId && /^[0-9a-f]{64}$/.test(m.params?.gate?.approved_intent_hash || ''), 'params.gate carries the intent id and canonical intent hash');
      assert(intake?.headers['x-a2h-api-key'] === API_KEY && intake?.headers.authorization === `Bearer ${API_KEY}`, 'authenticates with X-A2H-API-Key and Bearer by default');
      const intent = await waitState(a.intentId, 'waiting_input');
      const stored = intent?.approval_interactions?.[0]?.providerInteractionId ?? intent?.approval_interactions?.[0]?.provider_interaction_id;
      assert(!!recA.id && stored === recA.id, 'Gate stores the gateway interaction_id');
    }

    console.log('\nSigned webhook RESPONSE (spec §1.12) is verified before anything changes...');
    {
      const response = { ...gwSigned.buildResponse({ ...recA, decision: 'APPROVE', decidedAt: new Date().toISOString(), evidence: { factor: 'passkey.webauthn.v1', proof: {} } }) };
      const bad = await gwSigned.deliverWebhook(recA, response, { secret: 'wrong-secret' });
      assert(bad.status === 401 && bad.body?.reason === 'signature_invalid', 'wrong HMAC secret → 401 signature_invalid');
      const stale = await gwSigned.deliverWebhook(recA, response, { timestampSec: Math.floor(Date.now() / 1000) - 900 });
      assert(stale.status === 401 && stale.body?.reason === 'signature_timestamp_stale', 't= older than 5 minutes → 401 stale');
      const unknown = await gwSigned.deliverWebhook(recA, { ...response, responds_to: 'msg_does_not_exist', signature: undefined });
      assert(unknown.status === 401, 'responds_to for another interaction selects a different key → signature fails');
      const wrongInteraction = await gwSigned.deliverWebhook(recA, { ...response, interaction_id: 'someone-elses-interaction', signature: undefined });
      assert(wrongInteraction.status === 409 && wrongInteraction.body?.error === 'provider_interaction_mismatch', 'interaction_id not matching the dispatched one → 409');
      const tampered = await gwSigned.deliverWebhook(recA, { ...response, decided_at: new Date(Date.now() - 1000).toISOString() });
      assert(tampered.status === 401 && tampered.body?.reason === 'signature_invalid', 'body altered after the gateway signed it → JWS rejected');
      const stillWaiting = await getIntent(a.intentId);
      assert(stillWaiting.approval_state === 'waiting_input' && stillWaiting.status !== 'approved', 'none of the rejected deliveries changed the intent');
    }

    console.log('\nHuman approves on the gateway → Gate approves and can issue an execution order...');
    {
      const { delivery } = await gwSigned.decide(recA.id, 'APPROVE', { factor: 'passkey.webauthn.v1' });
      assert(delivery.status === 200 && delivery.body?.approvalState === 'answered', 'webhook RESPONSE accepted');
      assert(delivery.body?.approvalEvidence?.factor === 'passkey.webauthn.v1', 'evidence bundle records the human factor the gateway attested');
      const intent = await getIntent(a.intentId);
      assert(intent.status === 'approved' && intent.approval_state === 'answered', 'intent approved');
      const ledgerEvidence = intent.approval_interactions?.[0]?.evidence;
      assert(ledgerEvidence?.factors?.includes('a2h.jws.v1') && ledgerEvidence?.factors?.includes('a2h.signed_response.v1'), 'ledger records HMAC + JWS verification as factors');
      assert(ledgerEvidence?.proof?.a2h?.jws?.alg === 'ES256' && ledgerEvidence?.proof?.a2h?.transport === 'webhook', 'ledger keeps the gateway JWS details and transport');
      const exec = await req('POST', `/v1/intents/${a.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status === 201, 'execution token issuable after the verified decision');

      const replay = await gwSigned.deliverWebhook(recA, delivery.body ? { ...gwSigned.buildResponse(recA) } : {}, { deliveryId: delivery.deliveryId });
      assert(replay.status === 409 && replay.body?.error === 'duplicate_delivery', 'replayed X-A2H-Delivery-ID → 409 duplicate');
      const resend = await gwSigned.deliverWebhook(recA, gwSigned.buildResponse(recA));
      assert(resend.status === 409, 'a second RESPONSE for an answered interaction is refused');
    }

    console.log('\nDecline over webhook blocks the intent...');
    {
      const d = await propose('a2h-webhook');
      const rec = await gatewayRecordFor(gwSigned, d.messageId);
      await waitState(d.intentId, 'waiting_input');
      const { delivery } = await gwSigned.decide(rec.id, 'DECLINE', { factor: 'otp.sms.v1' });
      assert(delivery.status === 200 && delivery.body?.status === 'blocked', 'DECLINE → intent blocked');
      const exec = await req('POST', `/v1/intents/${d.intentId}/execute`, { apiKey: reviewer.apiKey });
      assert(exec.status !== 201, 'no execution token for a declined intent');
    }

    console.log('\nrequire_jws + required factors are enforced...');
    {
      const j = await propose('a2h-jws-required');
      const rec = await gatewayRecordFor(gwSigned, j.messageId);
      await waitState(j.intentId, 'waiting_input');
      const unsigned = { ...gwSigned.buildResponse({ ...rec, decision: 'APPROVE', decidedAt: new Date().toISOString(), evidence: { factor: 'passkey.webauthn.v1', proof: {} } }) };
      delete unsigned.signature;
      const r1 = await gwSigned.deliverWebhook(rec, unsigned);
      assert(r1.status === 401 && r1.body?.reason === 'signature_missing', 'unsigned RESPONSE rejected when require_jws is set');
      const otp = gwSigned.buildResponse({ ...rec, decision: 'APPROVE', decidedAt: new Date().toISOString(), evidence: { factor: 'otp.sms.v1', proof: {} } });
      const r2 = await gwSigned.deliverWebhook(rec, otp);
      assert(r2.status === 409 && r2.body?.missing?.includes('passkey.webauthn.v1'), 'signed OTP answer cannot satisfy a passkey requirement');
      const { delivery } = await gwSigned.decide(rec.id, 'APPROVE', { factor: 'passkey.webauthn.v1' });
      assert(delivery.status === 200 && (await getIntent(j.intentId)).status === 'approved', 'signed passkey answer satisfies the policy');
    }

    console.log('\nPoll-only gateway (like the reference gateway): Gate polls /v1/status...');
    {
      const p = await propose('a2h-poll');
      const rec = await gatewayRecordFor(gwPollOnly, p.messageId);
      const intake = gwPollOnly.requests.find((r) => r.path === '/v1/intent' && r.body?.message_id === p.messageId);
      assert(intake?.headers.authorization === `Bearer ${API_KEY}` && !intake?.headers['x-a2h-api-key'], 'auth: bearer sends only the Bearer header');
      assert(intake && !intake.body.callback, 'webhook: auto with an http:// callback URL asks for no webhook (spec requires HTTPS) — polls instead');
      await waitState(p.intentId, 'waiting_input');
      await gwPollOnly.decide(rec.id, 'APPROVE', { factor: 'push.v1' });
      const approved = await waitFor(async () => { const i = await getIntent(p.intentId); return i.status === 'approved' ? i : null; }, 5000);
      assert(!!approved, 'poller picks up the ANSWERED status and approves');
      assert(approved?.approval_interactions?.[0]?.evidence?.proof?.a2h?.transport === 'poll', 'ledger records the poll transport');
      assert(gwPollOnly.requests.some((r) => r.path === `/v1/status/${rec.id}`), 'status endpoint was polled with the gateway interaction id');
    }

    console.log('\nUnsigned poll result cannot satisfy a signed-response requirement (fail closed)...');
    {
      const s = await propose('a2h-poll-strict');
      const rec = await gatewayRecordFor(gwPollOnly, s.messageId);
      await waitState(s.intentId, 'waiting_input');
      await gwPollOnly.decide(rec.id, 'APPROVE', { factor: 'push.v1' });
      const intent = await waitState(s.intentId, 'failed', 4000);
      assert(!!intent && intent.status !== 'approved', 'approval fails closed instead of approving (or hanging open)');
    }

    console.log('\nA verified decline is honoured even without the approval factors...');
    {
      const n = await propose('a2h-jws-required');
      const rec = await gatewayRecordFor(gwSigned, n.messageId);
      await waitState(n.intentId, 'waiting_input');
      const { delivery } = await gwSigned.decide(rec.id, 'DECLINE', { factor: 'otp.sms.v1' });
      assert(delivery.status === 200 && delivery.body?.status === 'blocked', 'DECLINE without a passkey still blocks the intent');
    }

    console.log('\nGateway ERROR ERR.EXPIRED expires the approval...');
    {
      const e = await propose('a2h-webhook');
      const rec = await gatewayRecordFor(gwSigned, e.messageId);
      await waitState(e.intentId, 'waiting_input');
      const r = await gwSigned.deliverWebhook(rec, { type: 'ERROR', responds_to: e.messageId, error: { code: 'ERR.EXPIRED', message: 'Request expired' }, timestamp: new Date().toISOString() });
      assert(r.status === 200, 'signed ERROR accepted');
      assert((await getIntent(e.intentId)).approval_state === 'expired', 'approval_state → expired, never approved');
    }

    console.log('\nCancelling in Gate cancels the interaction on the gateway...');
    {
      const c = await propose('a2h-webhook');
      const rec = await gatewayRecordFor(gwSigned, c.messageId);
      await waitState(c.intentId, 'waiting_input');
      const r = await req('POST', `/v1/intents/${c.intentId}/cancel-approval`, { apiKey: reviewer.apiKey, body: { reason: 'agent withdrew' } });
      assert(r.status === 200, 'Gate cancel succeeds');
      const cancelled = await waitFor(() => rec.state === 'CANCELLED', 3000, 50);
      assert(!!cancelled, 'gateway received POST /v1/cancel/{interaction_id}');
    }

    console.log('\nGateway rejects Gate\'s credentials → approval fails closed...');
    {
      const b = await propose('a2h-bad-key');
      const intent = await waitState(b.intentId, 'failed');
      assert(!!intent && intent.status !== 'approved', 'approval_state failed, intent never approved');
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGKILL');
    await Promise.all([gwSigned.close(), gwPollOnly.close(), gwOtherKey.close()]);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(POLICY_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
