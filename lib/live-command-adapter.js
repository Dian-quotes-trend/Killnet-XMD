'use strict';

const { CommandRegistry } = require('./command-registry');
const { dispatch } = require('./command-router');
const { COMMAND_CATEGORIES } = require('./command-categories');

function normalizeCategory(category) {
  const value = String(category || '').toUpperCase();
  if (value === 'GENERAL') return COMMAND_CATEGORIES.CORE;
  if (Object.values(COMMAND_CATEGORIES).includes(value)) return value;
  return COMMAND_CATEGORIES.UTILITY;
}

/** Bridge legacy handlers into the normalized Phase 0 command contract. */
function createRegistryFromLegacyMap(commands) {
  if (!commands || typeof commands.entries !== 'function') throw new TypeError('A legacy command Map is required.');
  const registry = new CommandRegistry();
  for (const [name, item] of commands.entries()) {
    if (!item || typeof item.handler !== 'function') continue;
    registry.register({
      name,
      description: item.description || '',
      category: normalizeCategory(item.category),
      ownerOnly: Boolean(item.ownerOnly),
      handler: async (ctx) => item.handler(ctx.sock, ctx.rawMessage || ctx.message, ctx.args || []),
    });
  }
  return registry;
}

function createLegacyDispatchAdapter(commands, options = {}) {
  const registry = createRegistryFromLegacyMap(commands);
  return { registry, dispatch: (ctx) => dispatch(ctx, registry, options) };
}

module.exports = { createRegistryFromLegacyMap, createLegacyDispatchAdapter, normalizeCategory };
