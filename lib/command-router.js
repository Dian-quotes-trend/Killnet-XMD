// Killnet XMD — Phase 0B command router
// Dispatches normalized contexts through a registry.
// Permission middleware is intentionally left for Phase 0C.

async function dispatch(ctx, registry, options = {}) {
  if (!registry || typeof registry.resolve !== 'function') throw new TypeError('A command registry is required');
  if (!ctx || !ctx.command) return { handled: false, reason: 'not-a-command' };

  const command = registry.resolve(ctx.command);
  if (!command) return { handled: false, reason: 'unknown-command', command: ctx.command };

  if (command.groupOnly && !ctx.isGroup) {
    if (typeof options.onRejected === 'function') await options.onRejected(ctx, command, 'group-only');
    return { handled: false, rejected: true, reason: 'group-only', command: command.name };
  }

  await command.handler(ctx);
  return { handled: true, command: command.name };
}

module.exports = { dispatch };
