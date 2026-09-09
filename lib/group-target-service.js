// Killnet XMD — Phase 1A group target service
// Bridges group metadata into the pure target resolver without embedding feature logic.

const { resolveTarget, resolveTargets, resolveFromContext, createParticipantIndex } = require('./target-resolver');

async function loadGroupParticipants(sock, groupJid) {
  if (!sock || typeof sock.groupMetadata !== 'function') throw new Error('WhatsApp socket is required');
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) throw new Error('A group JID is required');
  const metadata = await sock.groupMetadata(groupJid);
  return Array.isArray(metadata?.participants) ? metadata.participants : [];
}

async function resolveGroupTarget(sock, groupJid, input, options = {}) {
  const participants = await loadGroupParticipants(sock, groupJid);
  return resolveTarget(input, participants, options);
}

async function resolveGroupTargets(sock, groupJid, inputs, options = {}) {
  const participants = await loadGroupParticipants(sock, groupJid);
  return resolveTargets(inputs, participants, options);
}

async function resolveGroupContextTarget(sock, groupJid, context, options = {}) {
  const participants = await loadGroupParticipants(sock, groupJid);
  return resolveFromContext(context, participants, options);
}

module.exports = {
  loadGroupParticipants,
  resolveGroupTarget,
  resolveGroupTargets,
  resolveGroupContextTarget,
  createParticipantIndex,
};
