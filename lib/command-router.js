// Killnet XMD — command router
// Fast path: resolve, authorize, execute. Transport and feature behavior stay outside.

const { authorize } = require('./permissions');

async function dispatch(ctx, registry, options = {}) {
  if (!registry || typeof registry.resolve !== 'function') throw new TypeError('A command registry is required');
  if (!ctx || !ctx.command) return { handled: false, reason: 'not-a-command' };

  const command = registry.resolve(ctx.command);
  if (!command) return { handled: false, reason: 'unknown-command', command: ctx.command };

  if (command.groupOnly && !ctx.isGroup) {
    if (typeof options.onRejected === 'function') await options.onRejected(ctx, command, 'group-only');
    return { handled: false, rejected: true, reason: 'group-only', command: command.name };
  }

  const authorization = authorize(ctx, command);
  if (!authorization.allowed) {
    if (typeof options.onRejected === 'function') await options.onRejected(ctx, command, authorization.reason, authorization);
    return { handled: false, rejected: true, reason: authorization.reason, command: command.name, missing: authorization.missing };
  }

  await command.handler(ctx);
  return { handled: true, command: command.name };
}

module.exports = { dispatch };
