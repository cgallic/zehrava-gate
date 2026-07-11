/**
 * Unit tests for the provider-neutral approval interaction ledger (#12),
 * principal/channel model (#4), and provider capability registry (#12/#15).
 *
 * Pure module tests — no server process, own throwaway DATA_DIR so it can
 * run standalone: `node test/approval-ledger.test.js`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ledger-test-'));

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

const db = require('../src/lib/db');
const {
  INTERACTION_STATES,
  createInteraction,
  getInteraction,
  getInteractionByMessageId,
  getLatestInteractionForIntent,
  listInteractionsForIntent,
  setProviderInteractionId,
  updateInteractionState,
} = require('../src/lib/approval-ledger');
const { redactChannelAddress, validatePrincipal, assuranceSatisfiedByChannel } = require('../src/lib/principal');
const { getProviderCapabilities, providerSupportsFactors, listApprovalProviders } = require('../src/lib/approval-providers');

function seedAgent(id) {
  db.prepare('INSERT INTO agents (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)').run(id, id, 'hash', Date.now());
}

function seedProposal(id, overrides = {}) {
  seedAgent(`agt_${id}`);
  db.prepare(`
    INSERT INTO proposals (id, sender_agent_id, destination, policy_id, status, created_at, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `agt_${id}`, overrides.destination || 'salesforce.import', 'crm-low-risk', 'pending_approval', Date.now(), `msg_${id}`);
}

console.log('\n  Approval Ledger / Principal / Provider Registry Tests');
console.log('  ═══════════════════════════════════════════════════════\n');

// ── Ledger: create + read ───────────────────────────────────────────────
console.log('createInteraction + getInteraction...');
{
  seedProposal('int_ledger1');
  const interaction = createInteraction({
    intentId: 'int_ledger1',
    provider: 'kaicalls',
    messageId: 'msg_int_ledger1',
    principalId: 'usr_abc123',
    channelType: 'kaicalls',
    channelAddressRedacted: redactChannelAddress('+15550001234'),
    requiredFactors: ['voice.ivr.v1'],
    expiresAt: Date.now() + 3600_000,
  });
  assert(interaction.id.startsWith('gai_'), 'interaction id has gai_ prefix');
  assert(interaction.state === INTERACTION_STATES.PENDING, 'starts in pending state');
  assert(interaction.principalId === 'usr_abc123', 'stores principal_id');
  assert(interaction.channelAddressRedacted === 'tel:+155****1234', 'redacts channel address');
  assert(JSON.stringify(interaction.requiredFactors) === JSON.stringify(['voice.ivr.v1']), 'stores required factors');

  const fetched = getInteraction(interaction.id);
  assert(fetched.id === interaction.id, 'getInteraction round-trips');

  const byMessage = getInteractionByMessageId('msg_int_ledger1');
  assert(byMessage.id === interaction.id, 'getInteractionByMessageId finds it');

  const latest = getLatestInteractionForIntent('int_ledger1');
  assert(latest.id === interaction.id, 'getLatestInteractionForIntent finds it');

  const list = listInteractionsForIntent('int_ledger1');
  assert(list.length === 1, 'listInteractionsForIntent returns one row');
}

// ── Ledger: state transitions ───────────────────────────────────────────
console.log('\nupdateInteractionState transitions...');
{
  seedProposal('int_ledger2');
  const interaction = createInteraction({ intentId: 'int_ledger2', provider: 'dashboard', messageId: 'msg_int_ledger2' });

  const toWaiting = updateInteractionState(interaction.id, INTERACTION_STATES.WAITING_INPUT);
  assert(toWaiting.ok, 'pending -> waiting_input succeeds');

  const toAnswered = updateInteractionState(interaction.id, INTERACTION_STATES.ANSWERED, { evidence: { decision: 'APPROVE' } });
  assert(toAnswered.ok, 'waiting_input -> answered succeeds');
  const answered = getInteraction(interaction.id);
  assert(answered.answeredAt !== null, 'answeredAt is set on terminal transition');
  assert(answered.evidence?.decision === 'APPROVE', 'stores evidence json');

  const reopen = updateInteractionState(interaction.id, INTERACTION_STATES.WAITING_INPUT);
  assert(!reopen.ok, 'cannot leave a terminal state');
  assert(reopen.reason === 'interaction_terminal', 'reason is interaction_terminal');
}

console.log('\nsetProviderInteractionId...');
{
  seedProposal('int_ledger3');
  const interaction = createInteraction({ intentId: 'int_ledger3', provider: 'kaicalls', messageId: 'msg_int_ledger3' });
  setProviderInteractionId(interaction.id, 'kc_external_123');
  const fetched = getInteraction(interaction.id);
  assert(fetched.providerInteractionId === 'kc_external_123', 'stores external provider interaction id');
}

// ── Principal/channel model (#4) ────────────────────────────────────────
console.log('\nredactChannelAddress...');
{
  assert(redactChannelAddress('+15550001234') === 'tel:+155****1234', 'redacts a phone number');
  assert(redactChannelAddress('connor@example.com') === 'email:c***@example.com', 'redacts an email');
  assert(redactChannelAddress(null) === null, 'null address stays null');
}

console.log('\nvalidatePrincipal...');
{
  const good = validatePrincipal({ principal_id: 'usr_abc123', channel: { type: 'sms', address: '+15550001234' } });
  assert(good.valid, 'opaque principal_id with typed channel is valid');

  const badEmail = validatePrincipal({ principal_id: 'connor@example.com' });
  assert(!badEmail.valid, 'email-shaped principal_id is rejected');

  const badPhone = validatePrincipal({ principal_id: '+15550001234' });
  assert(!badPhone.valid, 'phone-shaped principal_id is rejected');

  const missingType = validatePrincipal({ principal_id: 'usr_abc123', channel: { address: '+15550001234' } });
  assert(!missingType.valid, 'channel.address without channel.type is rejected');
}

console.log('\nassuranceSatisfiedByChannel...');
{
  assert(assuranceSatisfiedByChannel({ level: 'LOW', channelVerified: false }), 'LOW assurance does not require verification');
  assert(!assuranceSatisfiedByChannel({ level: 'HIGH', channelVerified: false }), 'HIGH assurance requires verification');
  assert(assuranceSatisfiedByChannel({ level: 'HIGH', channelVerified: true }), 'HIGH assurance passes when verified');
  assert(assuranceSatisfiedByChannel({ level: 'CRITICAL', channelVerified: false, allowUnverifiedOverride: true }), 'explicit override can bypass CRITICAL verification requirement');
}

// ── Provider capability registry (#12/#15) ──────────────────────────────
console.log('\nprovider capability registry...');
{
  assert(listApprovalProviders().includes('kaicalls'), 'kaicalls is a registered provider');
  assert(getProviderCapabilities('dashboard').includes('manual.dashboard.v1'), 'dashboard declares manual.dashboard.v1');
  assert(providerSupportsFactors('kaicalls', ['voice.ivr.v1']), 'kaicalls supports voice.ivr.v1');
  assert(!providerSupportsFactors('kaicalls', ['passkey.webauthn.v1']), 'kaicalls does not support passkey.webauthn.v1');
  assert(providerSupportsFactors('dashboard', []), 'empty requirement list is always satisfied');
  assert(!providerSupportsFactors('unknown-provider', ['sms.otp.v1']), 'unknown provider fails closed rather than assuming capability');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
