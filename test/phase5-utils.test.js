'use strict';

const assert = require('assert');
const { jid, lid, get, parseGetInput, fetchInput, channelId } = require('../lib/phase5-utils');

assert.strictEqual(jid(' 256700000000 '), '256700000000@s.whatsapp.net');
assert.strictEqual(jid('256700000000@s.whatsapp.net'), '256700000000@s.whatsapp.net');
assert.strictEqual(lid('123456@lid'), '123456@lid');
assert.strictEqual(lid('lid:123456'), '123456@lid');
assert.strictEqual(lid('256700000000'), '');
assert.strictEqual(get({ a: { b: 42 } }, 'a.b'), 42);
assert.strictEqual(get({ a: {} }, 'a.b', 'missing'), 'missing');
assert.deepStrictEqual(parseGetInput('{"a":{"b":42}} a.b'), { ok: true, source: { a: { b: 42 } }, propertyPath: 'a.b' });
assert.strictEqual(fetchInput('https://example.com').ok, true);
assert.strictEqual(fetchInput('ftp://example.com').reason, 'unsupported-protocol');
const channel = channelId('https://whatsapp.com/channel/ABC123');
assert.strictEqual(channel.ok, true);
assert.strictEqual(channel.normalized, 'ABC123');
assert.strictEqual(channel.jid, 'ABC123@newsletter');
console.log('Phase 5 utility tests passed');
