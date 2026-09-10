'use strict';

const assert = require('assert');
const { createLegacyDispatchAdapter } = require('../lib/live-command-adapter');
const { createLiveLifecycle } = require('../lib/live-lifecycle');

async function run() {
  const commands = new Map([['ping', { description: 'ping', ownerOnly: false, category: 'GENERAL', handler: async (sock, msg, args) => ({ sock, msg, args }) }]]);
  const adapter = createLegacyDispatchAdapter(commands);
  assert.ok(adapter.registry.resolve('ping'));
  assert.strictEqual(adapter.registry.resolve('ping').category, 'CORE');

  const lifecycle = createLiveLifecycle({ db: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false }, pick: (x) => x[0], emojis: ['👍'], isStable: () => false });
  assert.ok(lifecycle.dispatcher);
  assert.throws(() => lifecycle.phase6.assertReady(), /gate is closed/i);
  assert.strictEqual(lifecycle.state({ connected: false, credentialsReady: false }).stable, false);
  console.log('Runtime architecture tests passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
