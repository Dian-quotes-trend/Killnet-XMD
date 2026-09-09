'use strict';

const assert = require('assert');
const { normalizeConfig } = require('../lib/automation-config');
const { createAutomationModules, messageKey } = require('../lib/automation-modules');
const { jid, lid, get, fetchInput, channelId } = require('../lib/phase5-utils');
const { classifyStatusMessage, buildStatusKey, buildStatusAction, sessionLifecycleState, assertLifecycleStable } = require('../lib/phase6-lifecycle');

async function run() {
  const config = { get: async () => normalizeConfig({ global: { autoread: true, autoreact: true } }) };
  const modules = createAutomationModules({ config, pick: (items) => items[0], emojis: ['🔥'] });
  const message = { key: { remoteJid: '123@g.us', id: 'm1', fromMe: false }, message: { conversation: 'hello' } };
  assert.strictEqual(messageKey(message), '123@g.us:m1');
  const sock = { readMessages: async (keys) => { assert.deepStrictEqual(keys, [message.key]); }, sendMessage: async () => {} };
  assert.deepStrictEqual(await modules.autoread(sock, message), { ok: true });
  assert.strictEqual((await modules.autoreact(sock, message)).emoji, '🔥');

  assert.strictEqual(jid(' 123@s.whatsapp.net '), '123@s.whatsapp.net');
  assert.strictEqual(lid('123@lid'), '123@lid');
  assert.strictEqual(lid('123@s.whatsapp.net'), '');
  assert.strictEqual(get({ a: { b: 2 } }, 'a.b'), 2);
  assert.strictEqual(fetchInput(' x ').value, 'x');
  assert.strictEqual(channelId('https://example.test/').normalized, 'example.test');

  assert.deepStrictEqual(classifyStatusMessage({ key: { remoteJid: 'status@broadcast', id: 's1', participant: '7@s.whatsapp.net' } }), { isStatus: true, participant: '7@s.whatsapp.net', id: 's1' });
  assert.deepStrictEqual(buildStatusKey({ id: 's1', participant: '7@s.whatsapp.net' }), { remoteJid: 'status@broadcast', id: 's1', fromMe: false, participant: '7@s.whatsapp.net' });
  assert.deepStrictEqual(buildStatusAction('view', '7@s.whatsapp.net'), { action: 'view', target: '7@s.whatsapp.net' });
  assert.deepStrictEqual(sessionLifecycleState({ connected: true, credentialsReady: true }), { connected: true, reconnecting: false, credentialsReady: true, stable: true });
  assert.throws(() => assertLifecycleStable(false), /lifecycle gate is closed/);
  assert.doesNotThrow(() => assertLifecycleStable(true));

  console.log('Phase 4-6 tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
