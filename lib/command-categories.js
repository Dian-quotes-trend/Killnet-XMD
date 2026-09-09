// Killnet XMD — canonical command categories
// Category placement is metadata, not a reason to rewrite an existing handler.
// During migration, handlers can be moved without changing their behavior.

const COMMAND_CATEGORIES = Object.freeze({
  CORE: 'CORE',
  INFO: 'INFO',
  CONFIG: 'CONFIG',
  AUTOMATION: 'AUTOMATION',
  GROUP: 'GROUP',
  MODERATION: 'MODERATION',
  ADMIN: 'ADMIN',
  UTILITY: 'UTILITY',
});

// Known commands are classified here first. This lets the migration layer
// place commands correctly without rewriting their implementation.
const COMMAND_CATEGORY_MAP = Object.freeze({
  ping: COMMAND_CATEGORIES.CORE,
  alive: COMMAND_CATEGORIES.INFO,
  owner: COMMAND_CATEGORIES.INFO,
  info: COMMAND_CATEGORIES.INFO,
  menu: COMMAND_CATEGORIES.CORE,
  help: COMMAND_CATEGORIES.CORE,
  settings: COMMAND_CATEGORIES.CONFIG,

  autoread: COMMAND_CATEGORIES.AUTOMATION,
  autotyping: COMMAND_CATEGORIES.AUTOMATION,
  autorecording: COMMAND_CATEGORIES.AUTOMATION,
  autostatus: COMMAND_CATEGORIES.AUTOMATION,
  autoreact: COMMAND_CATEGORIES.AUTOMATION,
  autoreactstatus: COMMAND_CATEGORIES.AUTOMATION,
  antidelete: COMMAND_CATEGORIES.AUTOMATION,
  autoreply: COMMAND_CATEGORIES.AUTOMATION,
  presence: COMMAND_CATEGORIES.AUTOMATION,
  anticall: COMMAND_CATEGORIES.AUTOMATION,
  anticallmsg: COMMAND_CATEGORIES.AUTOMATION,

  tagall: COMMAND_CATEGORIES.GROUP,
  hidetag: COMMAND_CATEGORIES.GROUP,
  antilink: COMMAND_CATEGORIES.MODERATION,
  delete: COMMAND_CATEGORIES.MODERATION,
  del: COMMAND_CATEGORIES.MODERATION,

  mode: COMMAND_CATEGORIES.CONFIG,
  setprefix: COMMAND_CATEGORIES.CONFIG,
});

function categoryFor(name, fallback = COMMAND_CATEGORIES.UTILITY) {
  const key = String(name || '').trim().toLowerCase();
  return COMMAND_CATEGORY_MAP[key] || String(fallback).toUpperCase();
}

function classify(commands) {
  return (Array.isArray(commands) ? commands : []).map((command) => ({
    ...command,
    category: categoryFor(command.name, command.category),
  }));
}

module.exports = {
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_MAP,
  categoryFor,
  classify,
};
