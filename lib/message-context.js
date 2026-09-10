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

/**
 * Accepts either the original prefix string or an options object used by the
 * live runtime bridge. The latter keeps the existing Baileys transport
 * untouched while exposing the normalized context contract to the router.
 */
function normalizeMessageContext(rawMessage, prefixOrOptions = '.') {
  const options = prefixOrOptions && typeof prefixOrOptions === 'object'
    ? prefixOrOptions
    : { prefix: prefixOrOptions };
  const prefix = options.prefix || '.';
  const key = rawMessage?.key || {};
  const chatId = options.chatId || key.remoteJid || key.remoteJidAlt || '';
  const senderId = options.senderId || key.participant || key.participantAlt || key.participantPn || key.remoteJidAlt || chatId;
  const text = options.text != null ? String(options.text).trim() : extractText(rawMessage);
  const parsed = options.command
    ? (typeof options.command === 'string'
      ? parseCommand(options.command, prefix)
      : options.command)
    : parseCommand(text, prefix);

  return {
    rawMessage,
    message: rawMessage,
    sock: options.sock,
    actor: options.actor || senderId,
    chatId,
    senderId,
    isGroup: options.isGroup != null ? Boolean(options.isGroup) : isGroupJid(chatId),
    isStatus: options.isStatus != null ? Boolean(options.isStatus) : chatId === 'status@broadcast',
    text,
    command: parsed?.command || parsed?.name || null,
    args: parsed?.args || [],
    quoted: getQuoted(rawMessage),
    mentionedJids: getMentionedJids(rawMessage),
    isFromMe: Boolean(key.fromMe),
    isOwner: Boolean(options.isOwner),
    isMasterSudo: Boolean(options.isMasterSudo),
    isMember: options.isMember,
    isGroupAdmin: options.isGroupAdmin,
    isBotAdmin: options.isBotAdmin,
    capabilities: options.capabilities,
  };
}

// Backward-compatible alias used by the live runtime and existing consumers.
const createMessageContext = normalizeMessageContext;

module.exports = {
  normalizeMessageContext,
  createMessageContext,
  extractText,
  isGroupJid,
};
