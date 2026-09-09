'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createLocalJsonDatabase } = require('../lib/local-json-db');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'killnet-xmd-db-'));
  const file = path.join(dir, 'database.json');
  try {
    const db = createLocalJsonDatabase(file);

    assert.strictEqual(await db.has('missing'), false);
    assert.deepStrictEqual(await db.get('missing', { enabled: false }), { enabled: false });

    await db.set('settings', { prefix: '.', nested: { enabled: true } });
    const settings = await db.get('settings');
    settings.nested.enabled = false;
    assert.strictEqual((await db.get('settings')).nested.enabled, true);

    await db.update('settings', (current) => ({ ...current, prefix: '!' }));
    assert.strictEqual((await db.get('settings')).prefix, '!');

    await db.set('list', ['a', 'b']);
    const all = await db.all();
    assert.deepStrictEqual(all.list, ['a', 'b']);

    const restored = createLocalJsonDatabase(file);
    assert.deepStrictEqual(await restored.get('settings'), {
      prefix: '!',
      nested: { enabled: true },
    });

    assert.strictEqual(await restored.delete('list'), true);
    assert.strictEqual(await restored.delete('list'), false);
    assert.strictEqual(await restored.has('list'), false);

    await restored.clear();
    assert.deepStrictEqual(await restored.all(), {});

    console.log('Phase 0E smoke tests passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})();
