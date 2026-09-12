'use strict';

const assert = require('assert');
const { normalizeConfig } = require('../lib/automation-config');
const { createAutomationModules, messageKey } = require('../lib/automation-modules');
const { jid, lid, get, fetchInput, channelId } = require('../lib/phase5-utils');
const { classifyStatusMessage, buildStatusKey, buildStatusAction, sessionLifecycleState, assertLifecycleStable } = require('../lib/phase6-lifecycle');

async function run() {
  let configState = normalizeConfig({
    global: { autoread: true, autoreact: true, autotyping: true, presence: true },
    autoreply: { enabled: true, message: 'Auto reply' },
    anticall: { enabled: true, message: 'No calls' },
    status: { autoview: true, autolike: true, autosave: true },
  });
  const config = { get: async () => JSON.parse(JSON.stringify(configState)) };
  const modules = createAutomationModules({ config, pick: (items) => items[0], emojis: ['🔥'] });
  const message = { key: { remoteJid: '123@g.us', id: 'm1', fromMe: false }, message: { conversation: 'hello' } };
  assert.strictEqual(messageKey(message), '123@g.us:m1');

  const sent = [];
  const sock = {
    readMessages: async (keys) => {
      assert.ok(Array.isArray(keys) && keys.length === 1);
      assert.ok(keys[0]?.remoteJid);
      assert.ok(keys[0]?.id);
    },
    sendMessage: async (jidValue, payload) => { sent.push({ jid: jidValue, payload }); },
    sendPresenceUpdate: async () => {},
    copyNForward: async () => {},
    rejectCall: async () => {},
    user: { id: '999@s.whatsapp.net' },
  };

  assert.deepStrictEqual(await modules.autoread(sock, message), { ok: true });
  assert.strictEqual((await modules.autoreact(sock, message)).emoji, '🔥');
  assert.deepStrictEqual((await modules.typingOrRecording(sock, message)).ok, true);
  assert.deepStrictEqual((await modules.presence(sock, message)).ok, true);
  assert.deepStrictEqual((await modules.autoreply(sock, message)).ok, true);
  assert.strictEqual(sent.some((item) => item.payload?.text === 'Auto reply'), true);

  const callResult = await modules.anticall(sock, [{ id: 'call-1', from: '777@s.whatsapp.net' }]);
  assert.strictEqual(callResult.handled, 1);

  const statusMessage = { key: { remoteJid: 'status@broadcast', id: 's1', fromMe: false }, message: { imageMessage: {} } };
  const statusResult = await modules.status(sock, statusMessage);
  assert.strictEqual(statusResult.viewed, true);
  assert.strictEqual(statusResult.liked, true);
  assert.strictEqual(statusResult.saved, true);

  assert.strictEqual(jid(' 123@s.whatsapp.net '), '123@s.whatsapp.net');
  assert.strictEqual(lid('123@lid'), '123@lid');
  assert.strictEqual(lid('123@s.whatsapp.net'), '');
  assert.strictEqual(get({ a: { b: 2 } }, 'a.b'), 2);
  assert.strictEqual(fetchInput(' x ').value, 'x');
  assert.strictEqual(channelId('https://whatsapp.com/channel/Example_123').normalized, 'Example_123');
  assert.strictEqual(channelId('123456789@newsletter').jid, '123456789@newsletter');

  assert.deepStrictEqual(classifyStatusMessage({ key: { remoteJid: 'status@broadcast', id: 's1', participant: '7@s.whatsapp.net' } }), { isStatus: true, participant: '7@s.whatsapp.net', id: 's1' });
  assert.deepStrictEqual(buildStatusKey({ id: 's1', participant: '7@s.whatsapp.net' }), { remoteJid: 'status@broadcast', id: 's1', fromMe: false, participant: '7@s.whatsapp.net' });
  assert.deepStrictEqual(buildStatusAction('view', '7@s.whatsapp.net'), { action: 'view', target: '7@s.whatsapp.net' });
  assert.deepStrictEqual(sessionLifecycleState({ connected: true, credentialsReady: true }), { connected: true, reconnecting: false, credentialsReady: true, stable: true });
  assert.throws(() => assertLifecycleStable(false), /lifecycle gate is closed/);
  assert.doesNotThrow(() => assertLifecycleStable(true));

  console.log('Phase 4-6 tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
