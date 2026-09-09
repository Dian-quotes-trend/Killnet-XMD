// Killnet XMD — Phase 1B group mention service
// Centralizes mention payload construction on top of the Phase 1A target resolver.

const { createParticipantIndex, resolveTargets, resolveFromContext } = require('./target-resolver');

function displayNumber(target) {
  const jid = target?.jid || target?.id || '';
  return String(jid).split('@')[0].split(':')[0];
}

function mentionText(targets = [], label = '') {
  const names = targets.map(displayNumber).filter(Boolean);
  const prefix = label ? `${label}\n` : '';
  return `${prefix}${names.map((name) => `@${name}`).join(' ')}`.trim();
}

function mentionPayload(targets = [], text = '') {
  const mentions = [...new Set(targets.map((target) => target?.jid || target?.id).filter(Boolean))];
  return { text, mentions };
}

function buildTagPayload(targets, label = '📢') {
  return mentionPayload(targets, mentionText(targets, label));
}

function buildTagAllPayload(participants = [], botName = 'Killnet XMD', hidden = false) {
  const index = createParticipantIndex(participants);
  const targets = index.records;
  const text = hidden
    ? '📢 Attention everyone!'
    : `📢 *${botName} — TAG ALL*\n\n${targets.map(displayNumber).filter(Boolean).map((number) => `@${number}`).join('\n')}`;
  return mentionPayload(targets, text);
}

function resolveContextTargets(context, participants, options = {}) {
  return resolveFromContext(context, participants, options);
}

function resolveInputs(inputs, participants, options = {}) {
  return resolveTargets(inputs, participants, options);
}

module.exports = {
  displayNumber,
  mentionText,
  mentionPayload,
  buildTagPayload,
  buildTagAllPayload,
  resolveContextTargets,
  resolveInputs,
};
