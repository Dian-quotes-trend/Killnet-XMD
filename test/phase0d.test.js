const assert = require('assert');
const { createOwnerSudoStore, normalizeNumber, normalizeState } = require('../lib/owner-sudo');

(async () => {
  assert.strictEqual(normalizeNumber('+256 700-123-456'), '256700123456');
  assert.strictEqual(normalizeNumber(''), null);
  assert.deepStrictEqual(normalizeState({ ownerNumber: '+256700000001', masterSudo: '256 754 851 585' }), {
    ownerNumber: '256700000001',
    masterSudo: '256754851585',
  });

  const data = new Map();
  const adapter = {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
  };

  const access = createOwnerSudoStore(adapter, {
    ownerNumber: '256700000001',
    masterSudo: '256754851585',
  });

  assert.deepStrictEqual(await access.get(), {
    ownerNumber: '256700000001',
    masterSudo: '256754851585',
  });
  assert.strictEqual(access.matchesOwner('256 700 000 001'), true);
  assert.strictEqual(access.matchesMasterSudo('+256754851585'), true);

  await access.setOwner('+256 700 000 002');
  await access.setMasterSudo('256 754 851 586');
  assert.deepStrictEqual(data.get('access.ownerSudo'), {
    ownerNumber: '256700000002',
    masterSudo: '256754851586',
  });

  const restored = createOwnerSudoStore(adapter);
  assert.deepStrictEqual(await restored.load(), {
    ownerNumber: '256700000002',
    masterSudo: '256754851586',
  });

  await restored.clearOwner();
  assert.strictEqual((await restored.get()).ownerNumber, null);

  console.log('Phase 0D smoke tests passed');
})();
