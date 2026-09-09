const assert = require('assert');
const {
  isAdminParticipant,
  findParticipant,
  getGroupRoleState,
  assertGroupAdmin,
} = require('../lib/group-participant-service');

const participants = [
  { id: '256700000001@s.whatsapp.net', admin: 'superadmin' },
  { id: '256700000002@s.whatsapp.net', admin: 'admin' },
  { id: '256700000003@s.whatsapp.net', admin: null },
];

assert.strictEqual(isAdminParticipant(participants[0]), true);
assert.strictEqual(isAdminParticipant(participants[1]), true);
assert.strictEqual(isAdminParticipant(participants[2]), false);
assert.strictEqual(findParticipant(participants, '256700000002@s.whatsapp.net').admin, 'admin');

const state = getGroupRoleState(
  participants,
  '256700000002@s.whatsapp.net',
  '256700000001@s.whatsapp.net',
);
assert.strictEqual(state.actorIsAdmin, true);
assert.strictEqual(state.botIsAdmin, true);
assert.doesNotThrow(() => assertGroupAdmin(state));

assert.throws(
  () => assertGroupAdmin({ actorIsAdmin: false, botIsAdmin: true }),
  (error) => error.code === 'ACTOR_NOT_ADMIN',
);
assert.throws(
  () => assertGroupAdmin({ actorIsAdmin: true, botIsAdmin: false }),
  (error) => error.code === 'BOT_NOT_ADMIN',
);

console.log('Phase 1C tests passed.');
