'use strict';

const assert = require('assert');
const { sanitize, normalizeLevel, createLogger } = require('../lib/logger');
const { ERROR_TYPES, normalizeType, createErrorBoundary } = require('../lib/error-boundary');

(async () => {
  assert.strictEqual(normalizeLevel('DEBUG'), 'debug');
  assert.strictEqual(normalizeLevel('invalid'), 'info');

  const circular = {};
  circular.self = circular;
  const clean = sanitize({ token: 'secret', nested: { password: 'hidden', ok: true }, circular });
  assert.strictEqual(clean.token, '[REDACTED]');
  assert.strictEqual(clean.nested.password, '[REDACTED]');
  assert.strictEqual(clean.nested.ok, true);
  assert.strictEqual(clean.circular.self, '[Circular]');

  const logs = [];
  const sink = Object.fromEntries(['debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, (...args) => logs.push({ level, args })]));
  const logger = createLogger({ sink, minLevel: 'info', context: { component: 'test' } });
  logger.debug('hidden');
  logger.info('visible', { apiKey: 'secret' });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].args[1].data.apiKey, '[REDACTED]');

  const reported = [];
  const boundary = createErrorBoundary({ onError: async (error, details) => reported.push({ error, details }) });
  const success = await boundary.command('working', async () => 42);
  assert.strictEqual(success, 42);

  const failure = await boundary.automation('broken-auto', async () => { throw new Error('boom'); }, { automation: 'test' });
  assert.strictEqual(failure.ok, false);
  assert.strictEqual(failure.type, ERROR_TYPES.AUTOMATION);
  assert.strictEqual(failure.operation, 'broken-auto');
  assert.strictEqual(reported.length, 1);
  assert.strictEqual(reported[0].details.type, ERROR_TYPES.AUTOMATION);

  assert.strictEqual(normalizeType('connection'), ERROR_TYPES.CONNECTION);
  assert.strictEqual(normalizeType('unknown'), ERROR_TYPES.INTERNAL);

  console.log('Phase 0G smoke tests passed');
})();
