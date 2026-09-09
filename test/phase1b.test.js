const assert = require('assert');
const {
  isGroupJid,
  uniqueJids,
  buildMentionText,
  createMentionPayload,
  validateGroup,
} = require('../lib/group-mention-service');

const members = [
  { id: '256700000001@s.whatsapp.net' },
  { jid: '256700000002@s.whatsapp.net' },
  { id: '256700000001@s.whatsapp.net' },
];

assert.strictEqual(isGroupJid('12345-67890@g.us'), true);
assert.strictEqual(isGroupJid('256700000001@s.whatsapp.net'), false);
assert.strictEqual(validateGroup('12345-67890@g.us'), true);
assert.strictEqual(validateGroup('status@broadcast'), false);

const jids = uniqueJids(members);
assert.deepStrictEqual(jids, ['256700000001@s.whatsapp.net', '256700000002@s.whatsapp.net']);

const visible = buildMentionText(jids, { botName: 'Killnet XMD' });
assert.ok(visible.includes('@256700000001'));
assert.ok(visible.includes('@256700000002'));
assert.ok(visible.includes('TAG ALL'));

const hidden = buildMentionText(jids, { hidden: true });
assert.strictEqual(hidden, '📢 Attention everyone!');

const payload = createMentionPayload(members, { botName: 'Killnet XMD' });
assert.deepStrictEqual(payload.mentions, jids);
assert.ok(payload.text.includes('@256700000001'));

console.log('Phase 1B group mention tests passed.');
