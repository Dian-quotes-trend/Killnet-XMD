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
  return String(content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || '').trim();
}

function randomPick(items, fallback) {
  if (!Array.isArray(items) || !items.length) return fallback;
  return items[Math.floor(Math.random() * items.length)] || fallback;
}

function createAutomationModules({ config, pick = randomPick, emojis = ['❤️', '🔥', '💯', '✨', '👍'], chatbotResponder } = {}) {
  if (!config || typeof config.get !== 'function') throw new Error('automation config store is required');

  return {
    async autoread(sock, message) {
      if (!shouldProcessMessage(message)) return { skipped: true };
      const settings = await config.get();
      if (!settings.global.autoread) return { skipped: true };
      await sock.readMessages([message.key]);
      return { ok: true };
    },

    async presence(sock, message) {
      if (!message?.key?.remoteJid || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      if (!settings.global.presence) return { skipped: true };
      await sock.sendPresenceUpdate('available', message.key.remoteJid);
      return { ok: true };
    },

    async autoreact(sock, message) {
      if (!shouldProcessMessage(message) || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      if (!settings.global.autoreact) return { skipped: true };
      const emoji = pick(emojis, '👍');
      await sock.sendMessage(message.key.remoteJid, { react: { text: emoji, key: message.key } });
      return { ok: true, emoji };
    },

    async typingOrRecording(sock, message) {
      if (!shouldProcessMessage(message) || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      const typing = Boolean(settings.global.autotyping);
      const recording = Boolean(settings.global.autorecording);
      const randomMode = Boolean(settings.global.autorecordtype);
      if (!typing && !recording && !randomMode) return { skipped: true };
      let state = randomMode ? (Math.random() < 0.5 ? 'composing' : 'recording') : recording ? 'recording' : 'composing';
      if (typing && recording && !randomMode) state = Math.random() < 0.5 ? 'composing' : 'recording';
      await sock.sendPresenceUpdate(state, message.key.remoteJid);
      return { ok: true, state };
    },

    async autoreply(sock, message, prefix = process.env.PREFIX || '.') {
      if (!shouldProcessMessage(message) || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      if (!settings.autoreply?.enabled || !settings.autoreply.message) return { skipped: true };
      const text = extractText(message);
      if (!text || text.startsWith(prefix)) return { skipped: true };
      await sock.sendMessage(message.key.remoteJid, { text: settings.autoreply.message }, { quoted: message });
      return { ok: true };
    },

    async chatbot(sock, message) {
      if (!shouldProcessMessage(message) || message.key.remoteJid === STATUS_JID) return { skipped: true };
      const settings = await config.get();
      const jid = message.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const isDm = jid.endsWith('@s.whatsapp.net');
      const enabled = Boolean(settings.chatbot?.global || settings.chatbot?.chats?.[jid] || (isGroup && settings.chatbot?.group) || (isDm && settings.chatbot?.dm));
      if (!enabled) return { skipped: true };
      const text = extractText(message);
      if (!text || typeof chatbotResponder !== 'function') return { skipped: true, reason: typeof chatbotResponder === 'function' ? 'no message text' : 'chatbot provider not configured' };
      const reply = await chatbotResponder({ sock, message, text, jid, settings });
      if (!reply) return { skipped: true };
      await sock.sendMessage(jid, { text: String(reply) }, { quoted: message });
      return { ok: true };
    },

    async status(sock, message) {
      if (message?.key?.remoteJid !== STATUS_JID || !message?.message || message.key.fromMe) return { skipped: true };
      const settings = await config.get();
      const result = {};
      if (settings.global.antistatus) return { skipped: true, blocked: true };
      if (settings.status?.autoview) {
        await sock.readMessages([message.key]);
        result.viewed = true;
      }
      if (settings.status?.autolike) {
        await sock.sendMessage(STATUS_JID, { react: { text: '❤️', key: message.key } });
        result.liked = true;
      }
      if (settings.status?.autosave) {
        const target = sock?.user?.id;
        if (target && typeof sock.copyNForward === 'function') {
          await sock.copyNForward(target, message, true);
          result.saved = true;
        }
      }
      return result;
    },

    async anticall(sock, calls = []) {
      const settings = await config.get();
      if (!settings.anticall?.enabled || !Array.isArray(calls)) return { skipped: true };
      let handled = 0;
      for (const call of calls) {
        const caller = call?.from || call?.chatId || call?.peerJid;
        const id = call?.id;
        if (!caller || !id) continue;
        if (typeof sock.rejectCall === 'function') await sock.rejectCall(id, caller);
        if (settings.anticall.message) await sock.sendMessage(caller, { text: settings.anticall.message });
        handled += 1;
      }
      return { ok: true, handled };
    },

    chatbotEligibility(message) {
      if (!shouldProcessMessage(message)) return false;
      return config.get().then((settings) => {
        const jid = message.key.remoteJid;
        if (!jid || jid === STATUS_JID) return false;
        const isGroup = jid.endsWith('@g.us');
        const isDm = jid.endsWith('@s.whatsapp.net');
        return Boolean(settings.chatbot?.global || settings.chatbot?.chats?.[jid] || (isGroup && settings.chatbot?.group) || (isDm && settings.chatbot?.dm));
      });
    },

    extractText,
  };
}

module.exports = { STATUS_JID, messageKey, shouldProcessMessage, extractText, createAutomationModules };
