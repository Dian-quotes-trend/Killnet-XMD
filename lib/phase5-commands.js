'use strict';

const { COMMAND_CATEGORIES } = require('./command-categories');
const { jid, lid, get, parseGetInput, fetchInput, channelId, MAX_REDIRECTS } = require('./phase5-utils');

function reply(ctx, text) {
  return ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.rawMessage });
}

function registerOrReplace(registry, definition) {
  const existing = registry.resolve(definition.name);
  if (existing) {
    existing.handler = definition.handler;
    existing.description = definition.description;
    existing.category = definition.category;
    return existing;
  }
  return registry.register(definition);
}

async function fetchMetadata(urlText) {
  let current = urlText;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const input = fetchInput(current);
    if (!input.ok) throw new Error(input.reason);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(input.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'Killnet-XMD/3.0' },
      });

      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAX_REDIRECTS) throw new Error('too-many-redirects');
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect-without-location');
        current = new URL(location, input.url).toString();
        continue;
      }

      return {
        status: response.status,
        contentType: response.headers.get('content-type') || 'unknown',
        length: response.headers.get('content-length') || 'unknown',
        url: input.url.toString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('fetch-failed');
}

function registerPhase5Commands(registry) {
  registerOrReplace(registry, {
    name: 'jid',
    description: 'Normalize a WhatsApp JID or phone number',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const value = jid(ctx.args?.join(' ') || '');
      return reply(ctx, value ? `🆔 JID: ${value}` : '❌ Invalid JID or phone number.');
    },
  });

  registerOrReplace(registry, {
    name: 'lid',
    description: 'Normalize an existing WhatsApp LID',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const value = lid(ctx.args?.join(' ') || '');
      if (!value) return reply(ctx, '❌ Provide an existing LID such as 123456@lid or lid:123456. A phone number cannot safely be converted to a LID without WhatsApp metadata.');
      return reply(ctx, `🪪 LID: ${value}`);
    },
  });

  registerOrReplace(registry, {
    name: 'get',
    description: 'Safely inspect a property path from JSON/value input',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const input = parseGetInput(ctx.args?.join(' ') || '');
      if (!input.ok) return reply(ctx, 'Usage: .get <JSON-or-value> <property.path>');
      const value = get(input.source, input.propertyPath);
      let rendered;
      try { rendered = JSON.stringify(value); } catch { rendered = String(value); }
      return reply(ctx, `🔎 ${rendered ?? 'undefined'}`);
    },
  });

  registerOrReplace(registry, {
    name: 'fetch',
    description: 'Fetch public URL metadata without downloading the body',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const input = fetchInput(ctx.args?.[0] || '');
      if (!input.ok) return reply(ctx, `❌ Fetch failed: ${input.reason}. Usage: .fetch <https-url>`);
      try {
        const result = await fetchMetadata(input.value);
        return reply(ctx, `🌐 Status: ${result.status}\nType: ${result.contentType}\nLength: ${result.length}\nURL: ${result.url}`);
      } catch (error) {
        return reply(ctx, `❌ Fetch failed: ${error?.message || error}`);
      }
    },
  });

  registerOrReplace(registry, {
    name: 'channel-id',
    description: 'Normalize a WhatsApp Channel ID or channel URL',
    category: COMMAND_CATEGORIES.UTILITY,
    aliases: ['channelid'],
    handler: async (ctx) => {
      const result = channelId(ctx.args?.join(' ') || '');
      if (!result.ok) return reply(ctx, `❌ Invalid channel identifier: ${result.reason}`);
      return reply(ctx, `📡 Channel ID: ${result.normalized}\n🆔 JID: ${result.jid}`);
    },
  });

  return registry;
}

module.exports = { registerPhase5Commands, fetchMetadata };
