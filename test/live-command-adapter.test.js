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
  ]);

  const registry = createRegistryFromLegacyMap(legacy);
  assert.strictEqual(registry.has('ping'), true);
  assert.strictEqual(registry.resolve('ping').category, 'CORE');
  assert.strictEqual(registry.resolve('settings').ownerOnly, true);

  // Semantic duplicates are aliases of one canonical command.
  assert.strictEqual(registry.names().includes('help'), false);
  assert.strictEqual(registry.names().includes('del'), false);
  assert.strictEqual(registry.resolve('help').name, 'menu');
  assert.strictEqual(registry.resolve('del').name, 'delete');

  for (const name of ['add', 'kick', 'promote', 'demote', 'gname', 'grouplink']) {
    assert.strictEqual(registry.has(name), true, `${name} should be registered`);
    assert.strictEqual(registry.resolve(name).category, 'GROUP');
    assert.strictEqual(registry.resolve(name).groupOnly, true);
  }

  // Existing legacy commands remain authoritative during incremental migration.
  assert.strictEqual(registry.resolve('tagall').description, 'Legacy tag all');
  assert.strictEqual(registry.resolve('tagall').ownerOnly, false);
  assert.strictEqual(registry.resolve('kick').handler instanceof Function, true);
  assert.strictEqual(registry.resolve('grouplink').handler instanceof Function, true);

  console.log('live-command-adapter tests passed');
})();
