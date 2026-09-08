// Killnet XMD — Phase 0A normalized message context
// Keeps raw Baileys message handling out of feature modules.

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const { parseCommand } = require('./command-parser');

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function extractText(message) {
  const content = message?.message || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  ).trim();
}

function getQuoted(message) {
  const context = message?.message?.extendedTextMessage?.contextInfo;
  if (!context?.stanzaId) return null;

  return {
    id: context.stanzaId,
    participant: context.participant || context.participantAlt || null,
    quotedMessage: context.quotedMessage || null,
  };
}

function getMentionedJids(message) {
  const context = message?.message?.extendedTextMessage?.contextInfo;
  return Array.isArray(context?.mentionedJid)
    ? context.mentionedJid.filter(Boolean).map((jid) => jidNormalizedUser(jid))
    : [];
}

function normalizeMessageContext(rawMessage, prefix = '.') {
  const key = rawMessage?.key || {};
  const chatId = key.remoteJid || key.remoteJidAlt || '';
  const senderId = key.participant || key.participantAlt || key.participantPn || key.remoteJidAlt || chatId;
  const text = extractText(rawMessage);
  const parsed = parseCommand(text, prefix);

  return {
    rawMessage,
    chatId,
    senderId,
    isGroup: isGroupJid(chatId),
    text,
    command: parsed?.command || null,
    args: parsed?.args || [],
    quoted: getQuoted(rawMessage),
    mentionedJids: getMentionedJids(rawMessage),
    isFromMe: Boolean(key.fromMe),
  };
}

module.exports = {
  normalizeMessageContext,
  extractText,
  isGroupJid,
};
