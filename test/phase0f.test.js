'use strict';

const assert = require('assert');
const { EventDispatcher } = require('../lib/event-dispatcher');
const { AutomationRegistry } = require('../lib/automation-registry');

(async () => {
  const errors = [];
  const dispatcher = new EventDispatcher({ onError: async (error, context) => errors.push({ error, context }) });
  let calls = 0;

  const unsubscribe = dispatcher.on('message', async (payload) => { calls += payload.value; });
  await dispatcher.emit('MESSAGE', { value: 2 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(dispatcher.listenerCount('message'), 1);
  unsubscribe();
  assert.strictEqual(dispatcher.listenerCount('message'), 0);

  let onceCalls = 0;
  dispatcher.once('ping', () => { onceCalls += 1; });
  await dispatcher.emit('ping');
  await dispatcher.emit('ping');
  assert.strictEqual(onceCalls, 1);

  dispatcher.on('failure', () => { throw new Error('expected failure'); });
  dispatcher.on('failure', () => { calls += 1; });
  const result = await dispatcher.emit('failure');
  assert.strictEqual(result.delivered, 2);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(calls, 3);
  assert.strictEqual(errors.length, 1);

  const registry = new AutomationRegistry();
  let automationCalls = 0;
  registry.register({
    name: 'Auto Reply',
    events: ['message.received'],
    handler: async (payload) => { automationCalls += payload.amount; },
  });
  assert.strictEqual(registry.isEnabled('AUTO REPLY'), true);
  registry.attach(dispatcher);
  await dispatcher.emit('message.received', { amount: 3 });
  assert.strictEqual(automationCalls, 3);
  registry.disable('auto reply');
  await dispatcher.emit('message.received', { amount: 4 });
  assert.strictEqual(automationCalls, 3);
  registry.enable('auto reply');
  await dispatcher.emit('message.received', { amount: 5 });
  assert.strictEqual(automationCalls, 8);

  assert.throws(() => registry.register({ name: 'auto reply', events: ['x'], handler() {} }), /already registered/i);
  registry.detach();
  await dispatcher.emit('message.received', { amount: 10 });
  assert.strictEqual(automationCalls, 8);

  console.log('Phase 0F smoke tests passed');
})();
