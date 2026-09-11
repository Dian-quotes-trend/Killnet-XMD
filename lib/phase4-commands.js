'use strict';

const path = require('path');
const { COMMAND_CATEGORIES } = require('./command-categories');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createAutomationConfigStore } = require('./automation-config');

const AUTOMATION_KEYS = Object.freeze([
  'autoread', 'autotyping', 'autorecording', 'autorecordtype',
  'autoreact', 'presence', 'chatbot', 'antistatus',
]);
const STATUS_KEYS = Object.freeze(['autostatusview', 'autolikestatus', 'autostatussave']);
const ALIASES = Object.freeze({
  autoviewstatus: 'autostatusview',
  autoreactstatus: 'autolikestatus',
  auto_react: 'autoreact',
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

function getEnabled(config, name) {
  if (STATUS_KEYS.includes(name)) {
    const statusKey = name === 'autostatusview' ? 'autoview' : name === 'autolikestatus' ? 'autolike' : 'autosave';
    return Boolean(config.status?.[statusKey]);
  }
  if (name === 'chatbot') return Boolean(config.chatbot?.global);
  return Boolean(config.global?.[name]);
}

function setEnabled(config, name, enabled) {
  if (STATUS_KEYS.includes(name)) {
    const statusKey = name === 'autostatusview' ? 'autoview' : name === 'autolikestatus' ? 'autolike' : 'autosave';
    config.status = { ...config.status, [statusKey]: enabled };
    return config;
  }
  if (name === 'chatbot') {
    config.chatbot = { ...config.chatbot, global: enabled };
    config.global = { ...config.global, chatbot: enabled };
    return config;
  }
  config.global = { ...config.global, [name]: enabled };
  return config;
}

function registerPhase4Commands(registry, { config } = {}) {
  const store = config || createAutomationConfigStore({ db: createLocalJsonDatabase(path.resolve('./data/automation.json')) });
  if (!registry) throw new TypeError('command registry is required');

  for (const name of [...AUTOMATION_KEYS, ...STATUS_KEYS]) {
    const command = registry.resolve(name);
    const handler = async (ctx) => {
      const arg = ctx.args?.[0];
      const current = await store.get();
      const enabled = getEnabled(current, name);
      if (!arg || String(arg).toLowerCase() === 'status') return send(ctx, `⚙️ ${name}: ${enabled ? 'ON' : 'OFF'}`);
      const next = boolArg(arg);
      if (next === null) return send(ctx, `Usage: .${name} on/off/status`);
      await store.update((value) => setEnabled(value, name, next));
      return send(ctx, `✅ ${name}: ${next ? 'ON' : 'OFF'}`);
    };
    if (command) command.handler = handler;
    else registry.register({ name, description: `Automation: ${name}`, category: COMMAND_CATEGORIES.AUTOMATION, ownerOnly: true, handler });
  }

  const autoReply = registry.resolve('autoreply');
  if (autoReply) {
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
  }

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

  const antiCallMsg = registry.resolve('anticallmsg');
  if (antiCallMsg) {
    antiCallMsg.handler = async (ctx) => {
      const args = ctx.args || [];
      const current = await store.get();
      if (!args.length) return send(ctx, current.anticall?.message || '🚫 Calls are not allowed. Please send a message instead.');
      const message = args.join(' ').trim();
      await store.update((value) => ({ ...value, anticall: { ...(value.anticall || {}), message } }));
      return send(ctx, '✅ Anti-call message updated.');
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

module.exports = { registerPhase4Commands, AUTOMATION_KEYS, STATUS_KEYS, ALIASES, key };
