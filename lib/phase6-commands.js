'use strict';

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { COMMAND_CATEGORIES } = require('./command-categories');
const { createPhase6Boundary, classifyStatusMessage, buildStatusKey } = require('./phase6-lifecycle');
const { buildGroupStatusRequest } = require('./group-status-service');

const STATUS_JID = 'status@broadcast';
const STATUS_DIR = path.resolve('./data/status');

function reply(ctx, text) {
  return ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.rawMessage });
}

function quotedMessage(ctx) {
  const quoted = ctx?.rawMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const info = ctx?.rawMessage?.message?.extendedTextMessage?.contextInfo;
  if (!quoted || !info) return null;
  return {
    key: {
      remoteJid: info.remoteJid || ctx.chatId,
      id: info.stanzaId,
      fromMe: false,
      participant: info.participant || info.participantAlt,
    },
    message: quoted,
  };
}

function statusTarget(ctx) {
  const message = quotedMessage(ctx);
  if (!message) return null;
  const info = classifyStatusMessage(message);
  if (info.isStatus) return { message, key: buildStatusKey(info) };
  return null;
}

function mediaDescriptor(message) {
  const content = message?.message || {};
  for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
    if (content[type]) return { type: type.replace('Message', ''), content: content[type] };
  }
  return null;
}

async function downloadStatus(target) {
  const media = mediaDescriptor(target.message);
  if (!media) throw new Error('The replied status does not contain downloadable media.');
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const stream = await downloadContentFromMessage(media.content, media.type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const ext = media.type === 'image' ? 'jpg' : media.type === 'video' ? 'mp4' : 'ogg';
  const filename = `${Date.now()}-${String(target.key.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
  const file = path.join(STATUS_DIR, filename);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

function phase6Ready(sock) {
  return sock?.__killnetPhase6Ready === true;
}

function registerPhase6Commands(registry) {
  const register = (definition) => {
    const existing = registry.resolve(definition.name);
    if (existing) {
      existing.handler = definition.handler;
      existing.description = definition.description;
      existing.category = definition.category;
      existing.ownerOnly = Boolean(definition.ownerOnly);
      existing.groupOnly = Boolean(definition.groupOnly);
      return existing;
    }
    return registry.register(definition);
  };

  register({
    name: 'statusview',
    aliases: ['viewstatus'],
    description: 'View a replied WhatsApp status',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const boundary = createPhase6Boundary({ lifecycle: () => phase6Ready(ctx.sock) });
      boundary.assertReady();
      const target = statusTarget(ctx);
      if (!target?.key) return reply(ctx, '↩️ Reply to a WhatsApp status with .statusview.');
      if (typeof ctx.sock.readMessages !== 'function') throw new Error('Baileys readMessages is unavailable.');
      await ctx.sock.readMessages([target.key]);
      return reply(ctx, '👁️ Status marked as viewed.');
    },
  });

  register({
    name: 'statuslike',
    aliases: ['likestatus'],
    description: 'React to a replied WhatsApp status',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const boundary = createPhase6Boundary({ lifecycle: () => phase6Ready(ctx.sock) });
      boundary.assertReady();
      const target = statusTarget(ctx);
      if (!target?.key) return reply(ctx, '↩️ Reply to a WhatsApp status with .statuslike.');
      await ctx.sock.sendMessage(STATUS_JID, { react: { text: '❤️', key: target.key } });
      return reply(ctx, '❤️ Status reaction sent.');
    },
  });

  register({
    name: 'statussave',
    aliases: ['savestatus'],
    description: 'Save a replied WhatsApp status to the bot account',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const boundary = createPhase6Boundary({ lifecycle: () => phase6Ready(ctx.sock) });
      boundary.assertReady();
      const target = statusTarget(ctx);
      if (!target?.message) return reply(ctx, '↩️ Reply to a WhatsApp status with .statussave.');
      const targetJid = ctx.sock?.user?.id;
      if (!targetJid || typeof ctx.sock.copyNForward !== 'function') throw new Error('Baileys status-save operation is unavailable.');
      await ctx.sock.copyNForward(targetJid, target.message, true);
      return reply(ctx, '💾 Status saved to the bot chat.');
    },
  });

  register({
    name: 'statusdownload',
    aliases: ['downloadstatus', 'dlstatus'],
    description: 'Download media from a replied WhatsApp status',
    category: COMMAND_CATEGORIES.UTILITY,
    handler: async (ctx) => {
      const boundary = createPhase6Boundary({ lifecycle: () => phase6Ready(ctx.sock) });
      boundary.assertReady();
      const target = statusTarget(ctx);
      if (!target?.message) return reply(ctx, '↩️ Reply to a media status with .statusdownload.');
      const file = await downloadStatus(target);
      return reply(ctx, `⬇️ Status saved locally.\n${file}`);
    },
  });

  register({
    name: 'groupstatus',
    aliases: ['togroupstatus'],
    description: 'Publish a text update to WhatsApp Status for the current group',
    category: COMMAND_CATEGORIES.GROUP,
    groupOnly: true,
    handler: async (ctx) => {
      const boundary = createPhase6Boundary({ lifecycle: () => phase6Ready(ctx.sock) });
      boundary.assertReady();
      const group = ctx.chatId || '';
      if (!group.endsWith('@g.us')) return reply(ctx, '👥 This command is for groups only.');
      const text = (ctx.args || []).join(' ').trim() || '📢 Group update';
      const request = buildGroupStatusRequest(group, text);
      await ctx.sock.sendMessage(request.jid, request.payload, { statusJidList: request.statusJidList });
      return reply(ctx, '📢 Group status published.');
    },
  });

  register({
    name: 'session',
    aliases: ['pair', 'getsession'],
    description: 'Show the current WhatsApp session state',
    category: COMMAND_CATEGORIES.ADMIN,
    ownerOnly: true,
    handler: async (ctx) => {
      const state = ctx.sock?.__killnetSessionState || { connected: false, reconnecting: false, credentialsReady: false, stable: false };
      const user = ctx.sock?.user?.id || 'unknown';
      return reply(ctx, `🔐 Session\n• User: ${user}\n• Connected: ${state.connected ? 'yes' : 'no'}\n• Credentials: ${state.credentialsReady ? 'ready' : 'not ready'}\n• Stable: ${state.stable ? 'yes' : 'no'}`);
    },
  });

  return registry;
}

module.exports = { registerPhase6Commands, downloadStatus, statusTarget };
