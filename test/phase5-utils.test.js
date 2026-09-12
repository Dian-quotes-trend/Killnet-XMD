'use strict';

const assert = require('assert');
const { CommandRegistry } = require('../lib/command-registry');
const { registerPhase5Commands } = require('../lib/phase5-commands');
const { jid, lid, get, parseGetInput, fetchInput, channelId } = require('../lib/phase5-utils');

assert.strictEqual(jid(' 256700000000 '), '256700000000@s.whatsapp.net');
assert.strictEqual(jid('256700000000@s.whatsapp.net'), '256700000000@s.whatsapp.net');
assert.strictEqual(jid('not-a-jid'), '');
assert.strictEqual(jid(''), '');
assert.strictEqual(lid('123456@lid'), '123456@lid');
assert.strictEqual(lid('lid:123456'), '123456@lid');
assert.strictEqual(lid('256700000000'), '');
assert.strictEqual(get({ a: { b: 42 } }, 'a.b'), 42);
assert.strictEqual(get({ a: {} }, 'a.b', 'missing'), 'missing');
assert.strictEqual(get({ constructor: { secret: true } }, 'constructor.secret'), true);
assert.strictEqual(get({}, '__proto__.secret', 'blocked'), 'blocked');
assert.deepStrictEqual(parseGetInput('{"a":{"b":42}} a.b'), { ok: true, source: { a: { b: 42 } }, propertyPath: 'a.b' });
assert.strictEqual(parseGetInput('only-one-token').ok, false);
assert.strictEqual(fetchInput('https://example.com').ok, true);
assert.strictEqual(fetchInput('ftp://example.com').reason, 'unsupported-protocol');
assert.strictEqual(fetchInput('http://127.0.0.1').reason, 'private-or-local-host-blocked');
assert.strictEqual(fetchInput('http://localhost').reason, 'private-or-local-host-blocked');
assert.strictEqual(fetchInput('https://example.com:8080').reason, 'unsupported-port');
assert.strictEqual(fetchInput('https://user:pass@example.com').reason, 'credentials-not-allowed');
const channel = channelId('https://whatsapp.com/channel/ABC123');
assert.strictEqual(channel.ok, true);
assert.strictEqual(channel.normalized, 'ABC123');
assert.strictEqual(channel.jid, 'ABC123@newsletter');
assert.strictEqual(channelId('123456@newsletter').jid, '123456@newsletter');
assert.strictEqual(channelId('https://example.com/channel/ABC123').ok, false);

const registry = new CommandRegistry();
registerPhase5Commands(registry);
for (const name of ['jid', 'lid', 'get', 'fetch', 'channel-id']) assert.strictEqual(registry.has(name), true);
assert.strictEqual(registry.resolve('channelid').name, 'channel-id');
assert.strictEqual(registry.names().filter((name) => name === 'jid').length, 1);

console.log('Phase 5 utility/command tests passed');
