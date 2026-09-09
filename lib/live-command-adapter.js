'use strict';

const { CommandRegistry } = require('./command-registry');
const { dispatch } = require('./command-router');
const { CATEGORY } = require('./command-categories');

/**
 * Bridges the existing legacy command Map to the Phase 0 command registry.
 * This allows incremental migration without rewriting working handlers.
 */
function createRegistryFromLegacyMap(commands) {
  if (!commands || typeof commands.entries !== 'function') {
    throw new TypeError('A legacy command Map is required.');
  }

  const registry = new CommandRegistry();
  for (const [name, item] of commands.entries()) {
    if (!item || typeof item.handler !== 'function') continue;

    registry.register({
      name,
      description: item.description || '',
      category: normalizeCategory(item.category),
      handler: item.handler,
      ownerOnly: Boolean(item.ownerOnly),
    });
  }

  return registry;
}

function normalizeCategory(category) {
  const value = String(category || '').toUpperCase();
  if (value === 'GENERAL') return CATEGORY.CORE;
  if (Object.values(CATEGORY).includes(value)) return value;
  return CATEGORY.UTILITY;
}

function createLegacyDispatchAdapter(commands, options = {}) {
  const registry = createRegistryFromLegacyMap(commands);
  return {
    registry,
    dispatch(ctx) {
      return dispatch(ctx, registry, options);
    },
  };
}

module.exports = {
  createRegistryFromLegacyMap,
  createLegacyDispatchAdapter,
  normalizeCategory,
};
