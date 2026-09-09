const assert = require('assert');
const {
  assertGroupJid,
  requireSocketMethod,
  setGroupName,
  setGroupPicture,
  getGroupInviteLink,
} = require('../lib/group-metadata-service');

assert.doesNotThrow(() => assertGroupJid('12345-67890@g.us'));
assert.throws(() => assertGroupJid('256700000001@s.whatsapp.net'), (error) => error.code === 'INVALID_GROUP');

const sock = {
  groupUpdateSubject: async (jid, subject) => ({ jid, subject }),
  updateProfilePicture: async (jid, payload) => ({ jid, payload }),
  groupInviteCode: async () => 'ABC123',
};

assert.doesNotThrow(() => requireSocketMethod(sock, 'groupUpdateSubject'));
assert.throws(() => requireSocketMethod({}, 'groupUpdateSubject'), (error) => error.code === 'SOCKET_METHOD_UNAVAILABLE');

(async () => {
  const renamed = await setGroupName(sock, '12345-67890@g.us', 'Killnet Test');
  assert.deepStrictEqual(renamed, { jid: '12345-67890@g.us', subject: 'Killnet Test' });

  const picture = await setGroupPicture(sock, '12345-67890@g.us', Buffer.from('image'));
  assert.strictEqual(picture.jid, '12345-67890@g.us');
  assert.ok(picture.payload.image);

  const link = await getGroupInviteLink(sock, '12345-67890@g.us');
  assert.strictEqual(link, 'https://chat.whatsapp.com/ABC123');

  console.log('Phase 1D tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
