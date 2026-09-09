const assert = require('assert');
const {
  containsLink,
  createProtectionPolicy,
  decideCallAction,
  decideProtection,
} = require('../lib/group-protection-service');

assert.strictEqual(containsLink('visit https://example.com'), true);
assert.strictEqual(containsLink('hello everyone'), false);

const policy = createProtectionPolicy({
  groups: {
    '123@g.us': {
      antilink: { enabled: true, action: 'delete' },
      antistatus: { enabled: true, action: 'warn' },
    },
  },
});

assert.deepStrictEqual(
  policy.antilink('123@g.us', 'https://example.com', {}),
  { matched: true, enabled: true, action: 'delete', reason: 'link-detected' }
);
assert.strictEqual(policy.antilink('123@g.us', 'https://example.com', { isAdmin: true }).matched, false);
assert.strictEqual(policy.antistatus('123@g.us', { isStatus: true }, {}).matched, true);
assert.strictEqual(policy.antistatus('123@g.us', { isStatus: true }, { isPrivileged: true }).matched, false);

assert.deepStrictEqual(decideCallAction({ enabled: true, action: 'reject', message: 'Calls unavailable.' }), {
  enabled: true,
  action: 'reject',
  message: 'Calls unavailable.',
});
assert.deepStrictEqual(decideCallAction({ enabled: false }), { enabled: false, action: 'ignore' });
assert.deepStrictEqual(decideProtection({ matched: true, action: 'warn', reason: 'link-detected' }), {
  execute: true, action: 'warn', reason: 'link-detected',
});

console.log('Phase 1F tests passed.');
