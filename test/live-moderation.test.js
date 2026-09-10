'use strict';

const assert = require('assert');
const { createLocalJsonDatabase } = require('../lib/local-json-db');
const { createLiveModeration } = require('../lib/live-moderation');

async function run() {
  const db = createLocalJsonDatabase('./data/.test-live-moderation.json');
  await db.clear();
  const moderation = createLiveModeration({
    db,
    getGroups: async () => ({
      '123@g.us': { antilink: { enabled: true, action: 'warn' } },
    }),
    maxWarnings: 2,
  });

  const groupMetadata = {
    participants: [
      { id: 'bot@s.whatsapp.net', admin: 'admin' },
      { id: '7@s.whatsapp.net', admin: null },
    ],
  };
  const deleted = [];
  const sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async () => groupMetadata,
    sendMessage: async (jid, payload) => { deleted.push({ jid, payload }); },
  };
  const message = (id) => ({
    key: { remoteJid: '123@g.us', participant: '7@s.whatsapp.net', id, fromMe: false },
    message: { conversation: 'visit https://example.test' },
  });

  const first = await moderation.processMessage(sock, message('m1'));
  assert.strictEqual(first.warning.count, 1);
  assert.strictEqual(deleted.length, 0);

  const second = await moderation.processMessage(sock, message('m2'));
  assert.strictEqual(second.warning.count, 2);
  assert.strictEqual(second.escalated, 'delete');
  assert.strictEqual(deleted.length, 1);

  const stored = await moderation.warnings.get('123@g.us', '7@s.whatsapp.net');
  assert.strictEqual(stored.count, 2);
  assert.strictEqual(stored.history.length, 2);

  console.log('live-moderation tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });