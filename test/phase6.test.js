'use strict';

const assert = require('assert');
const { CommandRegistry } = require('../lib/command-registry');
const { registerPhase6Commands, statusTarget } = require('../lib/phase6-commands');
const { buildStatusKey, classifyStatusMessage, assertLifecycleStable, sessionLifecycleState } = require('../lib/phase6-lifecycle');

assert.strictEqual(classifyStatusMessage({ key: { remoteJid: '123@newsletter' } }).isStatus, false);
assert.strictEqual(classifyStatusMessage({ key: { remoteJid: 'status@broadcast', id: 'ABC', participant: '123@s.whatsapp.net' } }).isStatus, true);
assert.deepStrictEqual(buildStatusKey({ id: 'ABC', participant: '123@s.whatsapp.net' }), { remoteJid: 'status@broadcast', id: 'ABC', fromMe: false, participant: '123@s.whatsapp.net' });
assert.strictEqual(sessionLifecycleState({ connected: true, credentialsReady: true, reconnecting: false }).stable, true);
assert.strictEqual(sessionLifecycleState({ connected: true, credentialsReady: true, reconnecting: true }).stable, false);
assert.throws(() => assertLifecycleStable(false), (error) => error.code === 'PHASE6_LIFECYCLE_GATE_CLOSED');

const registry = new CommandRegistry();
registerPhase6Commands(registry);
for (const name of ['statusview', 'statuslike', 'statussave', 'statusdownload', 'groupstatus', 'session']) assert.strictEqual(registry.has(name), true, `${name} should be registered`);
assert.strictEqual(registry.resolve('pair').name, 'session');
assert.strictEqual(registry.resolve('downloadstatus').name, 'statusdownload');

const ctx = {
  chatId: '120@g.us',
  rawMessage: { message: { extendedTextMessage: { contextInfo: { remoteJid: 'status@broadcast', stanzaId: 'ABC', participant: '123@s.whatsapp.net', quotedMessage: { conversation: 'hello' } } } } },
};
assert.ok(statusTarget(ctx));
assert.strictEqual(statusTarget(ctx).key.remoteJid, 'status@broadcast');

console.log('Phase 6 tests passed');
