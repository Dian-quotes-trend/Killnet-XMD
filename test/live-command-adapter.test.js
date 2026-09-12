'use strict';

const assert = require('assert');
const { createRegistryFromLegacyMap, normalizeCategory } = require('../lib/live-command-adapter');

(async () => {
  assert.strictEqual(normalizeCategory('GENERAL'), 'CORE');
  assert.strictEqual(normalizeCategory('GROUP'), 'GROUP');
  assert.strictEqual(normalizeCategory('unknown'), 'UTILITY');

  const legacy = new Map([
    ['ping', { description: 'Ping', handler: async () => 'pong', category: 'GENERAL' }],
    ['menu', { description: 'Menu', handler: async () => 'menu', category: 'GENERAL' }],
    ['help', { description: 'Help duplicate', handler: async () => 'help', category: 'GENERAL' }],
    ['delete', { description: 'Delete', handler: async () => 'delete', category: 'GROUP' }],
    ['del', { description: 'Delete duplicate', handler: async () => 'del', category: 'GROUP' }],
    ['settings', { description: 'Settings', handler: async () => 'settings', ownerOnly: true, category: 'ADMIN' }],
    ['tagall', { description: 'Legacy tag all', handler: async () => 'tagall', category: 'GROUP' }],
    ['autoread', { description: 'Legacy autoread', handler: async () => 'legacy' }],
    ['autoreact', { description: 'Legacy autoreact', handler: async () => 'legacy' }],
    ['autotyping', { description: 'Legacy typing', handler: async () => 'legacy' }],
    ['autorecording', { description: 'Legacy recording', handler: async () => 'legacy' }],
    ['autorecordtype', { description: 'Legacy record/type', handler: async () => 'legacy' }],
    ['autoreply', { description: 'Legacy reply', handler: async () => 'legacy' }],
    ['anticall', { description: 'Legacy call', handler: async () => 'legacy' }],
    ['anticallmsg', { description: 'Legacy call message', handler: async () => 'legacy' }],
    ['antilink', { description: 'Legacy link', handler: async () => 'legacy' }],
    ['statusview', { description: 'Legacy status view', handler: async () => 'legacy' }],
    ['statusdownload', { description: 'Legacy status download', handler: async () => 'legacy' }],
    ['session', { description: 'Legacy session', handler: async () => 'legacy' }],
  ]);

  const registry = createRegistryFromLegacyMap(legacy);
  assert.strictEqual(registry.has('ping'), true);
  assert.strictEqual(registry.resolve('ping').category, 'CORE');
  assert.strictEqual(registry.resolve('settings').ownerOnly, true);
  assert.strictEqual(registry.names().includes('help'), false);
  assert.strictEqual(registry.names().includes('del'), false);
  assert.strictEqual(registry.resolve('help').name, 'menu');
  assert.strictEqual(registry.resolve('del').name, 'delete');

  for (const name of ['add', 'kick', 'promote', 'demote', 'gname', 'grouplink']) {
    assert.strictEqual(registry.has(name), true, `${name} should be registered`);
    assert.strictEqual(registry.resolve(name).category, 'GROUP');
    assert.strictEqual(registry.resolve(name).groupOnly, true);
  }

  for (const name of ['autoread', 'autoreact', 'autotyping', 'autorecording', 'autorecordtype', 'autoreply', 'anticall', 'anticallmsg', 'antilink']) {
    assert.strictEqual(registry.has(name), true, `${name} should be registered`);
    assert.strictEqual(registry.resolve(name).handler instanceof Function, true);
  }
  for (const name of ['statusview', 'statuslike', 'statussave', 'statusdownload', 'groupstatus', 'session']) {
    assert.strictEqual(registry.has(name), true, `${name} should be registered`);
    assert.strictEqual(registry.resolve(name).handler instanceof Function, true);
  }
  assert.strictEqual(registry.resolve('pair').name, 'session');
  assert.strictEqual(registry.resolve('downloadstatus').name, 'statusdownload');
  assert.strictEqual(registry.names().filter((name) => name === 'statusview').length, 1);
  assert.strictEqual(registry.names().filter((name) => name === 'session').length, 1);

  const menuMessages = [];
  await registry.resolve('menu').handler({
    prefix: '.',
    settings: { mode: 'private' },
    chatId: '123@s.whatsapp.net',
    rawMessage: { key: { id: 'menu-1' } },
    sock: { sendMessage: async (jid, payload) => { menuMessages.push({ jid, text: payload.text }); } },
  });
  assert.strictEqual(menuMessages.length, 1);
  const menuText = menuMessages[0].text;
  for (const command of ['.statusview', '.statuslike', '.statussave', '.statusdownload', '.groupstatus', '.session']) {
    assert.ok(menuText.includes(command), `${command} should appear in menu`);
  }
  for (const alias of ['.viewstatus', '.likestatus', '.savestatus', '.downloadstatus', '.dlstatus', '.togroupstatus', '.pair', '.getsession']) {
    assert.strictEqual(menuText.includes(alias), false, `${alias} should not duplicate the menu`);
  }

  assert.strictEqual(registry.resolve('tagall').description, 'Legacy tag all');
  assert.strictEqual(registry.resolve('tagall').ownerOnly, false);
  assert.strictEqual(registry.resolve('kick').handler instanceof Function, true);
  assert.strictEqual(registry.resolve('grouplink').handler instanceof Function, true);

  console.log('live-command-adapter tests passed');
})();
