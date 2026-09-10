'use strict';

const assert = require('assert');
const { createLiveLifecycle } = require('../lib/live-lifecycle');

async function run() {
  const calls = [];
  const lifecycle = createLiveLifecycle({
    dbPath: './data/test-live-lifecycle.json',
    pick: (items) => items[0],
    emojis: ['🔥'],
    isStable: () => false,
  });

  const message = { key: { remoteJid: '123@s.whatsapp.net', id: 'm1', fromMe: false }, message: { conversation: 'hello' } };
  const sock = {
    readMessages: async (keys) => calls.push(['read', keys]),
    sendMessage: async (...args) => calls.push(['send', args]),
    sendPresenceUpdate: async (...args) => calls.push(['presence', args]),
  };

  await lifecycle.emit('messages.upsert', { sock, messages: [message] });
  assert.ok(calls.some(([type]) => type === 'read') === false, 'disabled automation must remain disabled by default');
  assert.deepStrictEqual(lifecycle.state({ connected: true, credentialsReady: true }), { connected: true, reconnecting: false, credentialsReady: true, stable: true });
  assert.throws(() => lifecycle.phase6.assertReady(), /Phase 6 lifecycle gate is closed/);

  console.log('Live lifecycle tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
