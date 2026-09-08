const assert = require('assert');
const { CommandRegistry } = require('../lib/command-registry');
const { dispatch } = require('../lib/command-router');

(async () => {
  const registry = new CommandRegistry();
  const calls = [];

  registry.register({
    name: 'tag',
    description: 'Tag a target',
    category: 'GROUP',
    aliases: ['tagall'],
    groupOnly: true,
    handler: async (ctx) => calls.push(ctx.command),
  });

  assert.strictEqual(registry.resolve('tag').name, 'tag');
  assert.strictEqual(registry.resolve('tagall').name, 'tag');
  assert.strictEqual(registry.has('TAGALL'), true);
  assert.strictEqual(registry.has('missing'), false);

  let result = await dispatch({ command: 'tagall', isGroup: true }, registry);
  assert.deepStrictEqual(result, { handled: true, command: 'tag' });
  assert.deepStrictEqual(calls, ['tagall']);

  result = await dispatch({ command: 'tag', isGroup: false }, registry);
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.rejected, true);
  assert.strictEqual(result.reason, 'group-only');

  result = await dispatch({ command: 'unknown', isGroup: true }, registry);
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'unknown-command');

  console.log('Phase 0B smoke tests passed.');
})();
