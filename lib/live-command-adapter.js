'use strict';

const path = require('path');
const { CommandRegistry } = require('./command-registry');
const { dispatch } = require('./command-router');
const { COMMAND_CATEGORIES, categoryFor } = require('./command-categories');
const { manageParticipants, groupRoleState, assertGroupAdmin } = require('./group-participant-service');
const { setGroupName, getGroupInviteLink } = require('./group-metadata-service');
const { registerPlannedFeatures } = require('./planned-features');
const { registerFeatureAdmin } = require('./feature-admin');
const { registerPlannedCore } = require('./planned-core');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createAutomationConfigStore } = require('./automation-config');
const { registerPhase4Commands } = require('./phase4-commands');

const LEGACY_ALIASES = Object.freeze({ help: 'menu', del: 'delete' });
const PLANNED_OVERRIDES = new Set([
  'autoread', 'autoreact', 'autotyping', 'autorecording', 'autorecordtype',
  'autostatus', 'autostatusview', 'autoviewstatus', 'autoreactstatus',
  'autolikestatus', 'presence', 'anticall', 'anticallmsg', 'antistatus', 'antilink',
  'autoreply',
]);

function normalizeCategory(name, category) {
  const raw = String(name || '').trim().toUpperCase();
  if (raw === 'GENERAL') return COMMAND_CATEGORIES.CORE;
  if (Object.values(COMMAND_CATEGORIES).includes(raw)) return raw;
  const mapped = categoryFor(name);
  if (mapped !== COMMAND_CATEGORIES.UTILITY) return mapped;
  if (category === undefined) return COMMAND_CATEGORIES.UTILITY;
  const fallback = String(category || '').toUpperCase();
  return Object.values(COMMAND_CATEGORIES).includes(fallback) ? fallback : COMMAND_CATEGORIES.UTILITY;
}

function groupJid(ctx) {
  return ctx?.chatId || ctx?.rawMessage?.key?.remoteJid || ctx?.rawMessage?.key?.remoteJidAlt || '';
}

function actorJid(ctx) {
  return ctx?.actor || ctx?.senderId || ctx?.rawMessage?.key?.participant || ctx?.rawMessage?.key?.participantAlt || '';
}

function groupOnlyMessage(ctx) {
  return ctx?.sock?.sendMessage(ctx.chatId, { text: '╭─[ 👥 GROUP ONLY ]─╮\n│ This command works in groups.\n╰────────────────────╯' }, { quoted: ctx.rawMessage });
}

async function requireGroupAdmin(ctx) {
  const group = groupJid(ctx);
  if (!group.endsWith('@g.us')) throw new Error('This command is for groups only.');
  const state = await groupRoleState(ctx.sock, group, actorJid(ctx));
  assertGroupAdmin(state);
  return state;
}

function registerPhase1Commands(registry) {
  const register = (definition) => { if (!registry.has(definition.name)) registry.register(definition); };

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
        const verb = action === 'remove' ? 'Removed' : action[0].toUpperCase() + action.slice(1);
        return ctx.sock.sendMessage(group, {
          text: `╭─[ 👥 GROUP ACTION ]─╮\n│ • Action : ${verb}\n│ • Target : ${labels.join(', ') || 'none'}\n│ • Status : Completed\n╰──────────────────────╯`,
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
      if (!name) return ctx.sock.sendMessage(group, { text: `Usage: ${ctx.prefix || '.'}gname <name>` }, { quoted: ctx.rawMessage });
      await setGroupName(ctx.sock, group, name);
      return ctx.sock.sendMessage(group, { text: `╭─[ ✏️ GROUP NAME ]─╮\n│ • New name : ${name}\n│ • Status   : Updated\n╰────────────────────╯` }, { quoted: ctx.rawMessage });
    },
  });

  register({
    name: 'grouplink',
    description: 'Get the group invite link',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    aliases: ['gclink', 'invite'],
    handler: async (ctx) => {
      const group = groupJid(ctx);
      if (!group.endsWith('@g.us')) return groupOnlyMessage(ctx);
      await requireGroupAdmin(ctx);
      const link = await getGroupInviteLink(ctx.sock, group);
      return ctx.sock.sendMessage(group, { text: `╭─[ 🔗 GROUP LINK ]─╮\n│ ${link}\n╰───────────────────╯` }, { quoted: ctx.rawMessage });
    },
  });
}

function installDynamicMenu(registry) {
  const menu = registry.resolve('menu');
  if (!menu) return;

  menu.handler = async (ctx) => {
    const prefix = ctx.prefix || '.';
    const mode = String(ctx.settings?.mode || 'private').toUpperCase();
    const order = ['CORE', 'INFO', 'CONFIG', 'AUTOMATION', 'GROUP', 'MODERATION', 'ADMIN', 'UTILITY'];
    const headings = {
      CORE: '🧭 GENERAL',
      INFO: 'ℹ️ INFORMATION',
      CONFIG: '⚙️ CONFIGURATION',
      AUTOMATION: '🤖 AUTOMATION',
      GROUP: '👥 GROUP',
      MODERATION: '🛡️ MODERATION',
      ADMIN: '🔐 ADMIN — OWNER ONLY',
      UTILITY: '🧰 UTILITIES',
    };

    const lines = [
      '╭─━━━━━━━ ⦿ ━━━━━━━─╮',
      '│  ⚡ KILLNET XMD ⚡',
      '│  SMART AUTOMATION',
      '╰─━━━━━━━ ⦿ ━━━━━━━─╯',
      '',
      '┌─[ BOT INFO ]',
      '│ ◦ Creator : Dian Sybex Tech',
      `│ ◦ Prefix  : ${prefix}  |  Mode : ${mode}`,
      '│ ◦ Library : Baileys MD',
      '│ ◦ Version : 3.0 Premium',
      '└───────────',
      '',
    ];

    for (const category of order) {
      const items = registry.list(category).filter((item) => !item.aliasOf);
      if (!items.length) continue;
      lines.push(`╭─[ ${headings[category] || category} ]─╮`);
      for (const item of items) {
        const suffix = item.ownerOnly ? ' 🔒' : '';
        lines.push(`│ • ${prefix}${item.name} » ${item.description}${suffix}`);
      }
      lines.push('╰───────────────╯', '');
    }

    lines.push(
      '┌─[ NOTE ]─┐',
      `│ 💡 Use ${prefix}help for guide`,
      '│ 🔒 = Owner/Sudo Access Only',
      '│ 🛡️ Full Access: Owner + Master',
      '└──────────┘',
      '   ⚡ Powered By Dian Sybex Tech',
    );

    return ctx.sock.sendMessage(ctx.chatId, { text: lines.join('\n') }, { quoted: ctx.rawMessage });
  };
}

function createRegistryFromLegacyMap(commands) {
  if (!commands || typeof commands.entries !== 'function') throw new TypeError('A legacy command Map is required.');
  const registry = new CommandRegistry();
  const aliases = [];

  for (const [raw, item] of commands.entries()) {
    const name = String(raw || '').trim().toLowerCase();
    if (!item || typeof item.handler !== 'function') continue;
    if (PLANNED_OVERRIDES.has(name)) continue;
    const target = LEGACY_ALIASES[name];
    if (target && commands.has(target)) {
      aliases.push([name, target]);
      continue;
    }
    registry.register({
      name,
      description: item.description || '',
      category: normalizeCategory(name, item.category),
      ownerOnly: Boolean(item.ownerOnly),
      handler: async (ctx) => item.handler(ctx.sock, ctx.rawMessage || ctx.message, ctx.args || []),
    });
  }

  for (const [alias, target] of aliases) {
    if (registry.has(target) && !registry.has(alias)) registry.registerAlias(alias, target);
  }

  registerPhase1Commands(registry);
  registerPlannedCore(registry);
  registerPlannedFeatures(registry);
  registerFeatureAdmin(registry);

  const automationDb = createLocalJsonDatabase(path.resolve('./data/automation.json'));
  const automationConfig = createAutomationConfigStore({ db: automationDb });
  registerPhase4Commands(registry, { config: automationConfig });

  installDynamicMenu(registry);
  return registry;
}

function createLegacyDispatchAdapter(commands, options = {}) {
  const registry = createRegistryFromLegacyMap(commands);
  return { registry, dispatch: (ctx) => dispatch(ctx, registry, options) };
}

module.exports = {
  createRegistryFromLegacyMap,
  createLegacyDispatchAdapter,
  normalizeCategory,
  registerPhase1Commands,
  LEGACY_ALIASES,
  PLANNED_OVERRIDES,
};
