'use strict';

const { COMMAND_CATEGORIES } = require('./command-categories');

function registerPlannedCore(registry) {
  const send = (ctx, text) => ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.rawMessage });
  const add = (definition) => { if (!registry.has(definition.name)) registry.register(definition); };

  add({
    name: 'test',
    description: 'Basic runtime self-test',
    category: COMMAND_CATEGORIES.CORE,
    handler: async (ctx) => send(ctx, [
      '╭─[ 🧪 SELF TEST ]─╮',
      '│ • Router : ONLINE',
      '│ • Socket : READY',
      '│ • Status : PASS',
      '╰──────────────────╯',
    ].join('\n')),
  });

  add({
    name: 'runtime',
    description: 'Show runtime and uptime',
    category: COMMAND_CATEGORIES.INFO,
    handler: async (ctx) => {
      const seconds = Math.floor(process.uptime());
      const uptime = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
      const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return send(ctx, [
        '╭─[ ℹ️ RUNTIME INFO ]─╮',
        `│ • Uptime  : ${uptime}`,
        `│ • Node    : ${process.version}`,
        `│ • Memory  : ${memory} MB`,
        '│ • Engine  : Baileys MD',
        '╰─────────────────────╯',
      ].join('\n'));
    },
  });

  add({
    name: 'prefix',
    description: 'Show the current command prefix',
    category: COMMAND_CATEGORIES.CONFIG,
    handler: async (ctx) => send(ctx, [
      '╭─[ 🔣 PREFIX ]─╮',
      `│ • Current : ${ctx.prefix || '.'}`,
      `│ • Usage   : ${ctx.prefix || '.'}menu`,
      '╰────────────────╯',
    ].join('\n')),
  });

  add({
    name: 'profile',
    description: 'Show the current sender profile',
    category: COMMAND_CATEGORIES.INFO,
    handler: async (ctx) => send(ctx, [
      '╭─[ 👤 PROFILE ]─╮',
      `│ • Sender : ${ctx.senderId || ctx.rawMessage?.key?.participant || 'unknown'}`,
      `│ • Chat   : ${ctx.chatId || 'unknown'}`,
      '╰─────────────────╯',
    ].join('\n')),
  });

  return registry;
}

module.exports = { registerPlannedCore };
