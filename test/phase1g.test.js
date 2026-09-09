const assert = require('assert');
const {
  uniqueMessageKeys,
  buildClearChatPlan,
} = require('../lib/chat-cleanup-service');
const {
  STATUS_JID,
  buildGroupStatusPayload,
  buildGroupStatusRequest,
} = require('../lib/group-status-service');

const keys = [
  { remoteJid: '123@g.us', id: 'a' },
  { remoteJid: '123@g.us', id: 'a' },
  { remoteJid: '123@g.us', id: 'b' },
  { remoteJid: '', id: 'bad' },
];

assert.strictEqual(uniqueMessageKeys(keys).length, 2);
assert.deepStrictEqual(buildClearChatPlan(keys, { limit: 1 }), {
  action: 'delete',
  keys: [{ remoteJid: '123@g.us', id: 'a' }],
  skipped: 1,
});

assert.deepStrictEqual(buildGroupStatusPayload('Hello group', { mentions: ['1@s.whatsapp.net', '1@s.whatsapp.net'] }), {
  text: 'Hello group',
  mentions: ['1@s.whatsapp.net'],
});

assert.deepStrictEqual(buildGroupStatusRequest('123@g.us', 'Hello group', { mentions: ['1@s.whatsapp.net'] }), {
  jid: STATUS_JID,
  statusJid: STATUS_JID,
  groupJid: '123@g.us',
  payload: { text: 'Hello group', mentions: ['1@s.whatsapp.net'] },
});

assert.throws(() => buildGroupStatusRequest('not-a-group', 'Hello'), /group JID is required/i);
assert.throws(() => buildGroupStatusPayload('', {}), /Status text cannot be empty/i);

console.log('Phase 1G tests passed.');
