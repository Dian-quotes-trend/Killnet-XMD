'use strict';

const path = require('path');
const baileys = require('@whiskeysockets/baileys');
const { createLocalJsonDatabase } = require('./local-json-db');
const { normalizeJid } = require('./target-resolver');
const config = require('../config');

const originalMakeWASocket = baileys.default;
const { downloadMediaMessage, getContentType } = baileys;
const db = createLocalJsonDatabase(path.resolve('./data/database.json'));
const STATUS = 'status@broadcast';
const recent = new Set();

function keyName(name) { return String(name || '').toLowerCase(); }
async function enabled(name, chatId = '') {
  const state = await db.get('planned.features', { features: {}, groups: {} });
  const key = keyName(name);
  if (chatId && state.groups?.[chatId]?.features && Object.prototype.hasOwnProperty.call(state.groups[chatId].features, key)) return !!state.groups[chatId].features[key];
  return !!state.features?.[key];
}
function textOf(message) { const m=message?.message||{}; return String(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.videoMessage?.caption||m.documentMessage?.caption||'').trim(); }
function isGroup(jid) { return String(jid||'').endsWith('@g.us'); }
function ownerJid() { return normalizeJid(config.ownerNumber || process.env.OWNER_NUMBER || ''); }
async function safe(fn) { try { return await fn(); } catch (error) { console.error(`[planned-automation] ${error.message}`); return null; } }

async function saveStatus(sock, message) {
  const owner = ownerJid();
  if (!owner) return;
  const type = typeof getContentType === 'function' ? getContentType(message) : '';
  if (typeof downloadMediaMessage === 'function' && ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(type)) {
    const media = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    if (type === 'imageMessage') return sock.sendMessage(owner, { image: media, caption: `📥 Status from ${message.key.participant || 'unknown'}` });
    if (type === 'videoMessage') return sock.sendMessage(owner, { video: media, caption: `📥 Status from ${message.key.participant || 'unknown'}` });
    if (type === 'audioMessage') return sock.sendMessage(owner, { audio: media, mimetype: message.message.audioMessage?.mimetype || 'audio/mpeg' });
    if (type === 'stickerMessage') return sock.sendMessage(owner, { sticker: media });
    return sock.sendMessage(owner, { document: media, mimetype: message.message.documentMessage?.mimetype || 'application/octet-stream', fileName: message.message.documentMessage?.fileName || 'status-file' });
  }
  return sock.sendMessage(owner, { text: `📥 Status received from ${message.key.participant || message.key.remoteJidAlt || 'unknown'}\n${textOf(message) || '(text status)'}` });
}

function attachPlannedAutomations(sock) {
  if (!sock?.ev?.on || sock.__plannedAutomationsAttached) return sock;
  sock.__plannedAutomationsAttached = true;

  sock.ev.on('messages.upsert', async ({ messages = [] } = {}) => {
    for (const message of messages) {
      if (!message?.key || message.key.fromMe || !message.message) continue;
      const jid = message.key.remoteJid || '';
      const id = `${jid}:${message.key.id || ''}`;
      if (recent.has(id)) continue;
      recent.add(id); if (recent.size > 2000) recent.delete(recent.values().next().value);

      await safe(async () => {
        if (await enabled('autoread', jid)) await sock.readMessages([message.key]);
        if (jid !== STATUS && await enabled('autoreact', jid)) await sock.sendMessage(jid, { react: { text: '❤️', key: message.key } });
        if (jid !== STATUS && await enabled('presence', jid)) await sock.sendPresenceUpdate('available', jid);
        if (jid !== STATUS && await enabled('autotyping', jid)) { await sock.sendPresenceUpdate('composing', jid); setTimeout(() => safe(() => sock.sendPresenceUpdate('paused', jid)), 2500); }
        if (jid !== STATUS && await enabled('autorecording', jid)) { await sock.sendPresenceUpdate('recording', jid); setTimeout(() => safe(() => sock.sendPresenceUpdate('paused', jid)), 2500); }
        if (jid !== STATUS && await enabled('auto-recording-typing', jid)) { const mode = Math.random() < 0.5 ? 'composing' : 'recording'; await sock.sendPresenceUpdate(mode, jid); setTimeout(() => safe(() => sock.sendPresenceUpdate('paused', jid)), 2500); }

        if (jid === STATUS) {
          if (await enabled('auto-status-view')) await sock.readMessages([message.key]);
          if (await enabled('auto-status-like')) await sock.sendMessage(jid, { react: { text: '❤️', key: message.key } });
          if (await enabled('auto-status-save')) await saveStatus(sock, message);
          if (await enabled('antistatus')) return;
        }

        if (isGroup(jid) && await enabled('antilink', jid)) {
          const text = textOf(message);
          if (/https?:\/\/(?:chat\.whatsapp\.com|wa\.me)\//i.test(text)) {
            const bot = sock.user?.id ? normalizeJid(sock.user.id) : '';
            const meta = await sock.groupMetadata(jid);
            const botParticipant = (meta.participants || []).find(p => normalizeJid(p.id) === bot || normalizeJid(p.jid) === bot);
            if (botParticipant?.admin) await sock.sendMessage(jid, { delete: message.key });
          }
        }

        if (await enabled('chatbot', jid)) {
          const endpoint = process.env.CHATBOT_API_URL || '';
          const text = textOf(message);
          if (endpoint && text) {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, chatId: jid, sender: message.key.participant || message.key.remoteJid }) });
            if (response.ok) { const data = await response.json().catch(() => ({})); const reply = data.reply || data.text; if (reply) await sock.sendMessage(jid, { text: String(reply) }, { quoted: message }); }
          }
        }
      });
    }
  });

  sock.ev.on('call', async calls => { if (!(await enabled('anticall'))) return; for (const call of calls || []) if (call?.id && typeof sock.rejectCall === 'function') await safe(() => sock.rejectCall(call.id, call.from)); });
  return sock;
}

if (typeof originalMakeWASocket === 'function') baileys.default = function plannedMakeWASocket(...args) { return attachPlannedAutomations(originalMakeWASocket(...args)); };
module.exports = { attachPlannedAutomations };
