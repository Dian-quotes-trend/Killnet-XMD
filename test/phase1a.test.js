const assert = require('assert');
const {
  normalizeJid,
  identityCandidates,
  createParticipantIndex,
  resolveTarget,
  resolveTargets,
  resolveFromContext,
} = require('../lib/target-resolver');

const participants = [
  { id: '256700000001@s.whatsapp.net', lid: '100001@lid', admin: 'admin' },
  { id: '256700000002@s.whatsapp.net', lid: '100002@lid' },
  { id: '256700000003@s.whatsapp.net', lid: '100003@lid' },
];

const index = createParticipantIndex(participants);

assert.strictEqual(normalizeJid('256700000001'), '256700000001@s.whatsapp.net');
assert.ok(identityCandidates(participants[0]).includes('256700000001'));
assert.ok(identityCandidates(participants[0]).includes('100001@lid'));

let result = resolveTarget('256700000001', participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.target.jid, '256700000001@s.whatsapp.net');

result = resolveTarget('100001@lid', participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.target.jid, '256700000001@s.whatsapp.net');

result = resolveFromContext({ mentionedJids: ['100002@lid'], args: [] }, participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.source, 'mention');
assert.strictEqual(result.targets[0].jid, '256700000002@s.whatsapp.net');

result = resolveFromContext({ mentionedJids: [], quoted: { participant: '256700000003@s.whatsapp.net' }, args: [] }, participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.source, 'quote');
assert.strictEqual(result.targets[0].jid, '256700000003@s.whatsapp.net');

result = resolveFromContext({ mentionedJids: [], quoted: null, args: ['256700000002'] }, participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.source, 'argument');

result = resolveFromContext({ mentionedJids: [], quoted: null, args: [], senderId: '100003@lid' }, participants, { index, includeSender: true });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.source, 'sender');

result = resolveTargets(['256700000001', '100001@lid', '256700000002'], participants, { index });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.targets.length, 2);

result = resolveTarget('256799999999', participants, { index });
assert.strictEqual(result.ok, false);
assert.strictEqual(result.reason, 'not-found');

result = resolveTarget('', participants, { index });
assert.strictEqual(result.ok, false);
assert.strictEqual(result.reason, 'invalid-target');

const ambiguous = createParticipantIndex([
  { id: '256700000010@s.whatsapp.net', phoneNumber: '256700000099' },
  { id: '256700000011@s.whatsapp.net', phoneNumber: '256700000099' },
]);
result = resolveTarget('256700000099', [], { index: ambiguous });
assert.strictEqual(result.ok, false);
assert.strictEqual(result.reason, 'ambiguous');

console.log('Phase 1A target resolver tests passed.');
