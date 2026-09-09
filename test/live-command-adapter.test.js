'use strict';

const assert = require('assert');
const { createRegistryFromLegacyMap, normalizeCategory } = require('../lib/live-command-adapter');

(async () => {
  assert.strictEqual(normalizeCategory('GENERAL'), 'CORE');
  assert.strictEqual(normalizeCategory('GROUP'), 'GROUP');
  assert.strictEqual(normalizeCategory('unknown'), 'UTILITY');

  const legacy = new Map([
    ['ping', { description: 'Ping', handler: async () => 'pong', category: 'GENERAL' }],
    ['settings', { description: 'Settings', handler: async () => 'settings', ownerOnly: true, category: 'ADMIN' }],
  ]);

  const registry = createRegistryFromLegacyMap(legacy);
  assert.strictEqual(registry.has('ping'), true);
  assert.strictEqual(registry.resolve('ping').category, 'CORE');
  assert.strictEqual(registry.resolve('settings').ownerOnly, true);
  assert.deepStrictEqual(registry.names(), ['ping', 'settings']);

  console.log('live-command-adapter tests passed');
})();
