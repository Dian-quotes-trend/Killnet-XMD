const assert = require('assert');
const { authorize, CAPABILITIES } = require('../lib/permissions');
const { categoryFor } = require('../lib/command-categories');
const { CommandRegistry } = require('../lib/command-registry');
const { dispatch } = require('../lib/command-router');

(async () => {
  const publicResult = authorize({}, { permissions: ['PUBLIC'] });
  assert.strictEqual(publicResult.allowed, true);

  const ownerDenied = authorize({}, { permissions: ['OWNER'] });
  assert.strictEqual(ownerDenied.allowed, false);

  const ownerAllowed = authorize({ isOwner: true }, { permissions: ['OWNER'] });
  assert.strictEqual(ownerAllowed.allowed, true);

  const sudoAllowed = authorize({ isMasterSudo: true }, { ownerOnly: true });
  assert.strictEqual(sudoAllowed.allowed, true);

  const groupAdminDenied = authorize({ isGroupAdmin: false }, { permissions: ['GROUP_ADMIN'] });
  assert.strictEqual(groupAdminDenied.allowed, false);

  const groupAdminAllowed = authorize({ isGroupAdmin: true }, { permissions: ['GROUP_ADMIN'] });
  assert.strictEqual(groupAdminAllowed.allowed, true);

  const botAdminAllowed = authorize({ isBotAdmin: true }, { permissions: ['BOT_ADMIN'] });
  assert.strictEqual(botAdminAllowed.allowed, true);

  assert.strictEqual(categoryFor('antilink'), 'MODERATION');
  assert.strictEqual(categoryFor('setprefix'), 'CONFIG');
  assert.strictEqual(categoryFor('ping'), 'CORE');
  assert.strictEqual(categoryFor('unknown-command'), 'UTILITY');

  const registry = new CommandRegistry();
  let ran = false;
  registry.register({ name: 'secure', handler: async () => { ran = true; }, permissions: ['OWNER'] });

  const denied = await dispatch({ command: 'secure', isOwner: false }, registry);
  assert.strictEqual(denied.rejected, true);
  assert.strictEqual(denied.reason, 'permission-denied');
  assert.strictEqual(ran, false);

  const allowed = await dispatch({ command: 'secure', isOwner: true }, registry);
  assert.strictEqual(allowed.handled, true);
  assert.strictEqual(ran, true);

  // Prevent accidental use of an unknown privileged capability.
  assert.strictEqual(authorize({ capabilities: new Set([CAPABILITIES.PUBLIC]) }, { permissions: ['OWNER'] }).allowed, false);

  console.log('Phase 0C smoke tests passed');
})();
