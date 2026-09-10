'use strict';

const assert = require('assert');
const { createLegacyDispatchAdapter } = require('../lib/live-command-adapter');
const { createLiveLifecycle } = require('../lib/live-lifecycle');

async function run() {
  const commands = new Map([
    ['ping', { description: 'ping', ownerOnly: false, category: 'GENERAL', handler: async (sock, msg, args) => ({ sock, msg, args }) }],
    ['admin', { description: 'admin', ownerOnly: true, category: 'ADMIN', handler: async () => ({}) }],
  ]);
  const adapter = createLegacyDispatchAdapter(commands);
  assert.ok(adapter.registry.resolve('ping'));
  assert.strictEqual(adapter.registry.resolve('ping').category, 'CORE');
  assert.deepStrictEqual(adapter.registry.list('CORE').map((item) => item.name), ['ping']);
  assert.deepStrictEqual(adapter.registry.list('ADMIN').map((item) => item.name), ['admin']);

  const lifecycle = createLiveLifecycle({
    db: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      has: () => false,
    },
    pick: (x) => x[0],
    emojis: ['👍'],
    isStable: () => false,
  });
  assert.ok(lifecycle.dispatcher);
  assert.throws(() => lifecycle.phase6.assertReady(), /gate is closed/i);
  assert.strictEqual(lifecycle.state({ connected: false, credentialsReady: false }).stable, false);

  let updateCount = 0;
  const fakeSock = {
    ev: {
      on(event) {
        if (event === 'messages.upsert') updateCount += 1;
      },
    },
  };
  lifecycle.attach(fakeSock);
  assert.strictEqual(updateCount, 1);
  console.log('Runtime architecture tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
