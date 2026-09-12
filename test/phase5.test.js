'use strict';

const assert = require('assert');
const { CommandRegistry } = require('../lib/command-registry');
const { registerPhase5Commands } = require('../lib/phase5-commands');
const { jid, lid, get, parseGetInput, fetchInput, channelId } = require('../lib/phase5-utils');

(async () => {
  assert.strictEqual(jid('256700000000'), '256700000000@s.whatsapp.net');
  assert.strictEqual(jid('256700000000@s.whatsapp.net'), '256700000000@s.whatsapp.net');
  assert.strictEqual(jid(''), '');
  assert.strictEqual(jid('not-a-jid'), '');

  assert.strictEqual(lid('123456@lid'), '123456@lid');
  assert.strictEqual(lid('LID:123456'), '123456@lid');
  assert.strictEqual(lid('123456'), '');

  const sample = { a: { b: { c: 42 } }, constructor: 'safe' };
  assert.strictEqual(get(sample, 'a.b.c'), 42);
  assert.strictEqual(get(sample, 'missing.path', 'fallback'), 'fallback');
  assert.strictEqual(get(sample, '__proto__.polluted', 'fallback'), 'fallback');
  assert.strictEqual(get(sample, 'constructor'), 'safe');

  const parsed = parseGetInput('{"a":{"b":7}} a.b');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.source.a.b, 7);
  assert.strictEqual(parsed.propertyPath, 'a.b');
  assert.strictEqual(parseGetInput('only-one-token').ok, false);

  assert.strictEqual(fetchInput('javascript:alert(1)').ok, false);
  assert.strictEqual(fetchInput('http://127.0.0.1/').reason, 'private-or-local-host-blocked');
  assert.strictEqual(fetchInput('http://localhost/').ok, false);
  assert.strictEqual(fetchInput('https://example.com/').ok, true);
  assert.strictEqual(fetchInput('https://example.com:8080/').ok, false);

  assert.deepStrictEqual(channelId('123456@newsletter').jid, '123456@newsletter');
  assert.strictEqual(channelId('https://whatsapp.com/channel/AbCd_1234').jid, 'AbCd_1234@newsletter');
  assert.strictEqual(channelId('https://example.com/channel/AbCd_1234').ok, false);
  assert.strictEqual(channelId('https://whatsapp.com/foo/AbCd_1234').ok, false);

  const registry = new CommandRegistry();
  registerPhase5Commands(registry);
  for (const name of ['jid', 'lid', 'get', 'fetch', 'channel-id']) assert.strictEqual(registry.has(name), true);
  assert.strictEqual(registry.resolve('channelid').name, 'channel-id');
  assert.strictEqual(registry.names().filter((name) => name === 'jid').length, 1);

  console.log('phase5 tests passed');
})();
