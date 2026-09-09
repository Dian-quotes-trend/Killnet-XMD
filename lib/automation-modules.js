'use strict';

const STATUS_JID = 'status@broadcast';

function messageKey(message) {
  const key = message?.key || {};
  return `${key.remoteJid || ''}:${key.id || ''}`;
}

function shouldProcessMessage(message) {
  return Boolean(message?.message && message?.key && !message.key.fromMe && messageKey(message) !== ':');
}

function extractText(message) {
  const content = message?.message || {};
  return String(content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '').trim();
}

function createAutomationModules({ pick = (items) => items[Math.floor(Math.random() * items.length)], emojis = ['❤️', '🔥', '💯', '✨', '👍'], config } = {}) {
  if (!config || typeof config.get !== 'function') throw new Error('automation config store is required');

  return {
    async autoread(sock, message) {
      if (!shouldProcessMessage(message)) return { skipped: true };
      const settings = await config.get();
      if (!settings.global.autoread) return { skipped: true };
      await sock.readMessages([message.key]);
      return { ok: true };
    },
    async presence(sock, message, state = 'available') {
      const settings = await config.get();
      if (!settings.global.presence || !message?.key?.remoteJid) return { skipped: true };
      await sock.sendPresenceUpdate(state, message.key.remoteJid);
      return { ok: true };
    },
    async autoreact(sock, message) {
      if (!shouldProcessMessage(message) || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      if (!settings.global.autoreact) return { skipped: true };
      const emoji = pick(emojis);
      await sock.sendMessage(message.key.remoteJid, { react: { text: emoji, key: message.key } });
      return { ok: true, emoji };
    },
    async chatbotEligibility(message) {
      if (!shouldProcessMessage(message)) return false;
      const jid = message.key.remoteJid;
      if (!jid || jid === STATUS_JID) return false;
      const settings = await config.get();
      const isGroup = jid.endsWith('@g.us');
      const isDm = jid.endsWith('@s.whatsapp.net');
      return Boolean(settings.chatbot.global || settings.chatbot.chats?.[jid] || (isGroup && settings.chatbot.group) || (isDm && settings.chatbot.dm));
    },
    extractText,
  };
}

module.exports = { STATUS_JID, messageKey, shouldProcessMessage, extractText, createAutomationModules };
