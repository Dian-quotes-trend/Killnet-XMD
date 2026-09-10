'use strict';

const { CommandRegistry } = require('./command-registry');
const { dispatch } = require('./command-router');
const { COMMAND_CATEGORIES, categoryFor } = require('./command-categories');
const { createMentionPayload } = require('./group-mention-service');
const { manageParticipants, groupRoleState, assertGroupAdmin } = require('./group-participant-service');
const { setGroupName, getGroupInviteLink } = require('./group-metadata-service');

function normalizeCategory(categoryOrName, legacyCategory) {
  // Preserve the original one-argument migration helper contract.
  if (legacyCategory === undefined) {
    const value = String(categoryOrName || '').toUpperCase();
    if (value === 'GENERAL') return COMMAND_CATEGORIES.CORE;
    if (Object.values(COMMAND_CATEGORIES).includes(value)) return value;
    return COMMAND_CATEGORIES.UTILITY;
  }

  const fallback = String(legacyCategory || '').toUpperCase();
  return categoryFor(categoryOrName, Object.values(COMMAND_CATEGORIES).includes(fallback)
    ? fallback
    : COMMAND_CATEGORIES.UTILITY);
}

function groupJid(ctx) {
  return ctx?.chatId || ctx?.rawMessage?.key?.remoteJid || ctx?.rawMessage?.key?.remoteJidAlt || '';
}

function actorJid(ctx) {
  return ctx?.actor || ctx?.senderId || ctx?.rawMessage?.key?.participant || ctx?.rawMessage?.key?.participantAlt || '';
}

function groupOnlyMessage(ctx) {
  return ctx?.sock?.sendMessage(ctx.chatId, { text: 'ℹ️ This command is for groups only.' }, { quoted: ctx.rawMessage });
}

async function requireGroupAdmin(ctx) {
  const group = groupJid(ctx);
  if (!group.endsWith('@g.us')) throw new Error('This command is for groups only.');
  const state = await groupRoleState(ctx.sock, group, actorJid(ctx));
  assertGroupAdmin(state);
  return state;
}

function registerPhase1Commands(registry) {
  const register = (definition) => {
    if (!registry.has(definition.name)) registry.register(definition);
  };

  register({
    name: 'tagall',
    description: 'Mention all group members',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    handler: async (ctx) => {
      const group = groupJid(ctx);
      if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
      const metadata = await ctx.sock.groupMetadata(group);
      const payload = createMentionPayload(metadata.participants || [], { botName: ctx.settings?.botName });
      return ctx.sock.sendMessage(group, payload, { quoted: ctx.rawMessage });
    },
  });

  register({
    name: 'hidetag',
    description: 'Mention everyone without visible tags',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    handler: async (ctx) => {
      const group = groupJid(ctx);
      if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
      const metadata = await ctx.sock.groupMetadata(group);
      const payload = createMentionPayload(metadata.participants || [], { hidden: true });
      return ctx.sock.sendMessage(group, payload, { quoted: ctx.rawMessage });
    },
  });

  for (const action of ['add', 'remove', 'promote', 'demote']) {
    register({
      name: action === 'remove' ? 'kick' : action,
      description: `${action === 'remove' ? 'Remove' : action[0].toUpperCase() + action.slice(1)} group participant`,
      category: COMMAND_CATEGORIES.GROUP,
      groupOnly: true,
      handler: async (ctx) => {
        const group = groupJid(ctx);
        if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
        const result = await manageParticipants(ctx.sock, group, actorJid(ctx), ctx.args || [], action);
        const labels = result.targets.map((target) => `@${String(target.jid || target.id).split('@')[0]}`);
        return ctx.sock.sendMessage(group, {
          text: `✅ ${action === 'remove' ? 'Removed' : action[0].toUpperCase() + action.slice(1)}: ${labels.join(', ')}`,
          mentions: result.jids,
        }, { quoted: ctx.rawMessage });
      },
    });
  }

  register({
    name: 'gname',
    description: 'Change the group name',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    handler: async (ctx) => {
      const group = groupJid(ctx);
      if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
      await requireGroupAdmin(ctx);
      const name = (ctx.args || []).join(' ').trim();
      await setGroupName(ctx.sock, group, name);
      return ctx.sock.sendMessage(group, { text: `✅ Group name changed to: ${name}` }, { quoted: ctx.rawMessage });
    },
  });

  register({
    name: 'grouplink',
    aliases: ['gclink', 'invite'],
    description: 'Get the group invite link',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    handler: async (ctx) => {
      const group = groupJid(ctx);
      if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
      await requireGroupAdmin(ctx);
      const link = await getGroupInviteLink(ctx.sock, group);
      return ctx.sock.sendMessage(group, { text: `🔗 Group link:\n${link}` }, { quoted: ctx.rawMessage });
    },
  });
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
      category: normalizeCategory(name, item.category),
      ownerOnly: Boolean(item.ownerOnly),
      handler: async (ctx) => item.handler(ctx.sock, ctx.rawMessage || ctx.message, ctx.args || []),
    });
  }
  registerPhase1Commands(registry);
  return registry;
}

function createLegacyDispatchAdapter(commands, options = {}) {
  const registry = createRegistryFromLegacyMap(commands);
  return { registry, dispatch: (ctx) => dispatch(ctx, registry, options) };
}

module.exports = { createRegistryFromLegacyMap, createLegacyDispatchAdapter, normalizeCategory, registerPhase1Commands };
