'use strict';

const { jid, lid, get, parseGetInput, fetchInput, channelId } = require('./phase5-utils');

function reply(ctx, text) {
  return ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.rawMessage });
}

function registerPhase5Commands(registry) {
  const setHandler = (name, handler) => {
    const command = registry.resolve(name);
    if (command) command.handler = handler;
  };

  setHandler('jid', async (ctx) => {
    const input = String(ctx.args?.join(' ') || '').trim();
    const value = jid(input);
    return reply(ctx, value ? `🆔 JID: ${value}` : '❌ Invalid JID or phone number.');
  });

  setHandler('lid', async (ctx) => {
    const input = String(ctx.args?.join(' ') || '').trim();
    const value = lid(input);
    if (!value) return reply(ctx, '❌ Provide an existing LID in the form 123456@lid or lid:123456. A phone number cannot safely be converted to a LID without WhatsApp contact metadata.');
    return reply(ctx, `🪪 LID: ${value}`);
  });

  setHandler('get', async (ctx) => {
    const input = parseGetInput(ctx.args?.join(' ') || '');
    if (!input.ok) return reply(ctx, 'Usage: .get <JSON-or-value> <property.path>');
    const value = get(input.source, input.propertyPath);
    return reply(ctx, `🔎 ${JSON.stringify(value)}`);
  });

  setHandler('fetch', async (ctx) => {
    const input = fetchInput(ctx.args?.[0] || '');
    if (!input.ok) return reply(ctx, `❌ Fetch failed: ${input.reason}. Usage: .fetch <https-url>`);
    try {
      const response = await fetch(input.value, { redirect: 'follow' });
      const contentType = response.headers.get('content-type') || 'unknown';
      const length = response.headers.get('content-length') || 'unknown';
      return reply(ctx, `🌐 Status: ${response.status}\nType: ${contentType}\nLength: ${length}\nURL: ${response.url}`);
    } catch (error) {
      return reply(ctx, `❌ Fetch failed: ${error?.message || error}`);
    }
  });

  setHandler('channel-id', async (ctx) => {
    const input = ctx.args?.join(' ') || '';
    const result = channelId(input);
    if (!result.ok) return reply(ctx, `❌ Invalid channel URL: ${result.reason}`);
    return reply(ctx, `📡 Channel ID: ${result.normalized}\n🆔 JID: ${result.jid}`);
  });

  return registry;
}

module.exports = { registerPhase5Commands };
