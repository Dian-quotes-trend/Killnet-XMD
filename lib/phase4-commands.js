'use strict';

const path = require('path');
const { COMMAND_CATEGORIES } = require('./command-categories');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createAutomationConfigStore } = require('./automation-config');

const AUTOMATION_KEYS = Object.freeze(['autoread', 'autotyping', 'autorecording', 'autorecordtype', 'autoreact', 'presence', 'chatbot', 'antistatus']);
const STATUS_COMMANDS = Object.freeze([
  { name: 'auto-status-view', aliases: ['autostatusview', 'autoviewstatus'], key: 'autoview' },
  { name: 'auto-status-like', aliases: ['autolikestatus', 'autoreactstatus'], key: 'autolike' },
  { name: 'auto-status-save', aliases: ['autostatussave'], key: 'autosave' },
]);
const ALIASES = Object.freeze({
  autostatusview: 'auto-status-view', autoviewstatus: 'auto-status-view',
  autolikestatus: 'auto-status-like', autoreactstatus: 'auto-status-like',
  autostatussave: 'auto-status-save', auto_react: 'autoreact',
});

function key(name) {
  const value = String(name || '').trim().toLowerCase();
  return ALIASES[value] || value;
}

function send(ctx, text) {
  return ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.rawMessage });
}

function boolArg(value) {
  const v = String(value || '').toLowerCase();
  if (['on', 'true', 'enable', 'enabled'].includes(v)) return true;
  if (['off', 'false', 'disable', 'disabled'].includes(v)) return false;
  return null;
}

function isAutomationName(name) {
  const normalized = key(name);
  return AUTOMATION_KEYS.includes(normalized) || STATUS_COMMANDS.some((item) => item.name === normalized);
}

function getAutomationValue(config, name) {
  const normalized = key(name);
  const status = STATUS_COMMANDS.find((item) => item.name === normalized);
  if (status) return Boolean(config.status?.[status.key]);
  if (normalized === 'chatbot') return Boolean(config.chatbot?.global);
  return Boolean(config.global?.[normalized]);
}

function setAutomationValue(config, name, enabled) {
  const normalized = key(name);
  const status = STATUS_COMMANDS.find((item) => item.name === normalized);
  if (status) return { ...config, status: { ...config.status, [status.key]: enabled } };
  if (normalized === 'chatbot') return { ...config, global: { ...config.global, chatbot: enabled }, chatbot: { ...config.chatbot, global: enabled } };
  return { ...config, global: { ...config.global, [normalized]: enabled } };
}

function statusHandler(store, command) {
  return async (ctx) => {
    const arg = ctx.args?.[0];
    const current = await store.get();
    const enabled = Boolean(current.status?.[command.key]);
    if (!arg || String(arg).toLowerCase() === 'status') return send(ctx, `⚙️ ${command.name}: ${enabled ? 'ON' : 'OFF'}`);
    const next = boolArg(arg);
    if (next === null) return send(ctx, `Usage: .${command.name} on/off/status`);
    await store.update((value) => setAutomationValue(value, command.name, next));
    return send(ctx, `✅ ${command.name}: ${next ? 'ON' : 'OFF'}`);
  };
}

function registerPhase4Commands(registry, { config } = {}) {
  const store = config || createAutomationConfigStore({ db: createLocalJsonDatabase(path.resolve('./data/automation.json')) });
  if (!registry) throw new TypeError('command registry is required');

  for (const name of AUTOMATION_KEYS) {
    const command = registry.resolve(name);
    const handler = async (ctx) => {
      const arg = ctx.args?.[0];
      const current = await store.get();
      const enabled = getAutomationValue(current, name);
      if (!arg || String(arg).toLowerCase() === 'status') return send(ctx, `⚙️ ${name}: ${enabled ? 'ON' : 'OFF'}`);
      const next = boolArg(arg);
      if (next === null) return send(ctx, `Usage: .${name} on/off/status`);
      await store.update((value) => setAutomationValue(value, name, next));
      return send(ctx, `✅ ${name}: ${next ? 'ON' : 'OFF'}`);
    };
    if (command) command.handler = handler;
    else registry.register({ name, description: `Automation: ${name}`, category: COMMAND_CATEGORIES.AUTOMATION, ownerOnly: true, handler });
  }

  for (const command of STATUS_COMMANDS) {
    const target = registry.resolve(command.name) || registry.resolve(command.aliases[0]);
    const handler = statusHandler(store, command);
    if (target) target.handler = handler;
    else registry.register({ name: command.name, aliases: command.aliases, description: `Status automation: ${command.key}`, category: COMMAND_CATEGORIES.AUTOMATION, ownerOnly: true, handler });
  }

  let autoReply = registry.resolve('autoreply');
  if (!autoReply) {
    registry.register({ name: 'autoreply', description: 'Toggle or configure automatic replies', category: COMMAND_CATEGORIES.AUTOMATION, ownerOnly: true, handler: async () => {} });
    autoReply = registry.resolve('autoreply');
  }
  autoReply.handler = async (ctx) => {
    const args = ctx.args || [];
    const current = await store.get();
    if (!args.length) return send(ctx, `💬 Auto-reply: ${current.autoreply?.enabled ? 'ON' : 'OFF'}\n📝 ${current.autoreply?.message || '(not configured)'}`);
    const first = String(args[0]).toLowerCase();
    const enabled = boolArg(first);
    if (enabled !== null && args.length === 1) {
      await store.update((value) => ({ ...value, autoreply: { ...(value.autoreply || {}), enabled } }));
      return send(ctx, `💬 Auto-reply: ${enabled ? 'ON' : 'OFF'}`);
    }
    const message = args.join(' ').trim();
    await store.update((value) => ({ ...value, autoreply: { ...(value.autoreply || {}), enabled: true, message } }));
    return send(ctx, `✅ Auto-reply enabled.\n📝 ${message}`);
  };

  const antiCall = registry.resolve('anticall');
  if (antiCall) {
    antiCall.handler = async (ctx) => {
      const arg = ctx.args?.[0];
      const current = await store.get();
      if (!arg || String(arg).toLowerCase() === 'status') return send(ctx, `📵 Anti-call: ${current.anticall?.enabled ? 'ON' : 'OFF'}`);
      const next = boolArg(arg);
      if (next === null) return send(ctx, 'Usage: .anticall on/off/status');
      await store.update((value) => ({ ...value, anticall: { ...(value.anticall || {}), enabled: next } }));
      return send(ctx, `📵 Anti-call: ${next ? 'ON' : 'OFF'}`);
    };
  }

  let antiCallMsg = registry.resolve('anticallmsg');
  if (!antiCallMsg) {
    registry.register({ name: 'anticallmsg', description: 'Set the anti-call reply', category: COMMAND_CATEGORIES.AUTOMATION, ownerOnly: true, handler: async () => {} });
    antiCallMsg = registry.resolve('anticallmsg');
  }
  antiCallMsg.handler = async (ctx) => {
    const args = ctx.args || [];
    const current = await store.get();
    if (!args.length) return send(ctx, current.anticall?.message || '🚫 Calls are not allowed. Please send a message instead.');
    const message = args.join(' ').trim();
    await store.update((value) => ({ ...value, anticall: { ...(value.anticall || {}), message } }));
    return send(ctx, '✅ Anti-call message updated.');
  };

  const feature = registry.resolve('feature');
  if (feature) {
    const legacyFeatureHandler = feature.handler;
    feature.handler = async (ctx) => {
      const name = key(ctx.args?.[0]);
      const action = String(ctx.args?.[1] || '').toLowerCase();
      if (!isAutomationName(name)) return legacyFeatureHandler(ctx);
      if (!action || action === 'status') {
        const current = await store.get();
        return send(ctx, `⚙️ ${name}: ${getAutomationValue(current, name) ? 'ON' : 'OFF'}`);
      }
      const next = boolArg(action);
      if (next === null) return send(ctx, `Usage: .feature ${name} on/off/status`);
      await store.update((value) => setAutomationValue(value, name, next));
      return send(ctx, `✅ ${name}: ${next ? 'ON' : 'OFF'}`);
    };
  }

  const settings = registry.resolve('settings');
  if (settings) {
    settings.handler = async (ctx) => {
      const current = await store.get();
      return send(ctx, [
        '╭━━〔 *PHASE 4 AUTOMATION* 〕━━╮',
        `┃ 📖 Auto-read: ${current.global.autoread ? 'ON' : 'OFF'}`,
        `┃ ⌨️ Auto-typing: ${current.global.autotyping ? 'ON' : 'OFF'}`,
        `┃ 🎙️ Auto-recording: ${current.global.autorecording ? 'ON' : 'OFF'}`,
        `┃ 🔄 Auto-record/type: ${current.global.autorecordtype ? 'ON' : 'OFF'}`,
        `┃ ❤️ Auto-react: ${current.global.autoreact ? 'ON' : 'OFF'}`,
        `┃ 💬 Auto-reply: ${current.autoreply?.enabled ? 'ON' : 'OFF'}`,
        `┃ 📵 Anti-call: ${current.anticall?.enabled ? 'ON' : 'OFF'}`,
        `┃ 👁️ Status view: ${current.status?.autoview ? 'ON' : 'OFF'}`,
        `┃ ❤️ Status like: ${current.status?.autolike ? 'ON' : 'OFF'}`,
        `┃ 💾 Status save: ${current.status?.autosave ? 'ON' : 'OFF'}`,
        `┃ 🤖 Chatbot: ${current.chatbot?.global ? 'ON' : 'OFF'}`,
        `┃ 🟢 Presence: ${current.global.presence ? 'ON' : 'OFF'}`,
        '╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
      ].join('\n'));
    };
  }

  return store;
}

module.exports = { registerPhase4Commands, AUTOMATION_KEYS, STATUS_COMMANDS, ALIASES, key };
