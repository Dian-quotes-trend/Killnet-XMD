const assert = require('assert');
const { createWarningStore, normalizeWarningState, moderationDecision } = require('../lib/warning-service');

async function run() {
  const data = new Map();
  const db = {
    async get(key, fallback) { return data.has(key) ? data.get(key) : fallback; },
    async set(key, value) { data.set(key, JSON.parse(JSON.stringify(value))); },
  };

  const store = createWarningStore({ db, maxWarnings: 2, now: () => '2026-09-09T00:00:00.000Z' });

  assert.deepStrictEqual(normalizeWarningState(null), { version: 1, groups: {} });
  assert.deepStrictEqual(await store.get('123@g.us', '456@s.whatsapp.net'), {
    count: 0, history: [], updatedAt: null,
  });

  const first = await store.warn('123@g.us', '456@s.whatsapp.net', 'spam', { source: 'test' });
  assert.strictEqual(first.count, 1);
  assert.strictEqual(first.action, 'warn');
  assert.strictEqual(first.shouldEscalate, false);

  const second = await store.warn('123@g.us', '456@s.whatsapp.net', 'repeat spam');
  assert.strictEqual(second.count, 2);
  assert.strictEqual(second.action, 'threshold');
  assert.strictEqual(second.shouldEscalate, true);

  const persisted = await store.get('123@g.us', '456@s.whatsapp.net');
  assert.strictEqual(persisted.count, 2);
  assert.strictEqual(persisted.history.length, 2);
  assert.strictEqual(persisted.history[0].reason, 'spam');

  await store.reset('123@g.us', '456@s.whatsapp.net');
  assert.strictEqual((await store.get('123@g.us', '456@s.whatsapp.net')).count, 0);

  await store.warn('123@g.us', '789@s.whatsapp.net', 'rule violation');
  await store.clearGroup('123@g.us');
  assert.strictEqual((await store.get('123@g.us', '789@s.whatsapp.net')).count, 0);

  assert.deepStrictEqual(moderationDecision({ warningCount: 1, threshold: 3 }), {
    action: 'warn', count: 1, threshold: 3,
  });
  assert.deepStrictEqual(moderationDecision({ warningCount: 3, threshold: 3 }), {
    action: 'threshold', count: 3, threshold: 3,
  });

  console.log('Phase 1E tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
