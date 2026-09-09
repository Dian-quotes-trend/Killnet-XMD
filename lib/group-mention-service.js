// Killnet XMD — Phase 1B group mention service
// Builds mention payloads from already-resolved group participants.

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function participantJid(participant) {
  return participant?.jid || participant?.id || participant?.participant || '';
}

function uniqueJids(participants = []) {
  const seen = new Set();
  const result = [];
  for (const participant of participants) {
    const jid = participantJid(participant);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    result.push(jid);
  }
  return result;
}

function buildMentionText(jids, options = {}) {
  const label = options.label || 'Attention everyone!';
  if (options.hidden) return options.hiddenText || '📢 Attention everyone!';
  const botName = options.botName || 'Killnet XMD';
  const lines = jids.map((jid) => `@${String(jid).split('@')[0]}`);
  return `📢 *${botName} — TAG ALL*\n\n${lines.join('\n')}`;
}

function createMentionPayload(participants = [], options = {}) {
  const jids = uniqueJids(participants);
  return {
    text: buildMentionText(jids, options),
    mentions: jids,
  };
}

function validateGroup(chatId) {
  return isGroupJid(chatId);
}

module.exports = {
  isGroupJid,
  participantJid,
  uniqueJids,
  buildMentionText,
  createMentionPayload,
  validateGroup,
};
