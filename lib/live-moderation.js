'use strict';

const { createWarningStore } = require('./warning-service');
const { createProtectionPolicy, decideCallAction, decideProtection } = require('./group-protection-service');
const { extractText } = require('./automation-modules');

function actorFromMessage(sock, message, metadata) {
  const key = message?.key || {};
  const participant = key.participant || key.participantAlt || key.remoteJid || '';
  const isFromMe = Boolean(key.fromMe);
  const isAdmin = Boolean(metadata?.isAdmin);
  const isPrivileged = Boolean(metadata?.isPrivileged);
  return { sock, message, participant, isFromMe, isAdmin, isPrivileged };
}

function groupJid(message) {
  return message?.key?.remoteJid || message?.key?.remoteJidAlt || '';
}

function isGroupMessage(message) {
  return groupJid(message).endsWith('@g.us');
}

function createLiveModeration({ db, warningKey = 'moderation.warnings', maxWarnings = 3, getGroups, onError } = {}) {
  if (!db) throw new Error('A database adapter is required.');
  const warnings = createWarningStore({ db, key: warningKey, maxWarnings });

  async function groupMetadata(sock, group) {
    if (!sock || typeof sock.groupMetadata !== 'function') return null;
    return sock.groupMetadata(group);
  }

  async function actorState(sock, group, participant) {
    const metadata = await groupMetadata(sock, group);
    const entry = (metadata?.participants || []).find((item) =>
      item?.id === participant || item?.jid === participant || item?.lid === participant
    );
    return {
      metadata,
      isAdmin: Boolean(entry?.admin === 'admin' || entry?.admin === 'superadmin'),
      isBotAdmin: Boolean((metadata?.participants || []).some((item) =>
        (item?.id || item?.jid || item?.lid) === sock?.user?.id && (item?.admin === 'admin' || item?.admin === 'superadmin')
      )),
    };
  }

  async function processMessage(sock, message, settings = {}) {
    if (!isGroupMessage(message) || message?.key?.fromMe) return { skipped: true };
    const group = groupJid(message);
    const participant = message?.key?.participant || message?.key?.participantAlt || '';
    if (!participant) return { skipped: true, reason: 'missing-participant' };

    const groups = typeof getGroups === 'function' ? await getGroups() : (settings.groups || {});
    const policy = createProtectionPolicy({ groups: groups || {} });
    const text = extractText(message);

    // Fast path: when no antilink policy is enabled for this group, do not
    // perform a network groupMetadata lookup for every ordinary message.
    const configured = policy.get(group, 'antilink');
    if (!configured.enabled || !configured.action || configured.action === 'ignore' || !/(?:https?:\/\/|www\.)\S+/i.test(text)) {
      return { skipped: true, reason: 'no-active-antilink-match' };
    }

    const actorStateResult = await actorState(sock, group, participant);
    const actor = actorFromMessage(sock, message, actorStateResult);
    const protection = policy.antilink(group, text, actor);
    const decision = decideProtection(protection);
    if (!decision.execute) return { skipped: true, reason: decision.reason };

    const result = { action: decision.action, groupJid: group, userJid: participant };
    if (decision.action === 'warn') {
      const warning = await warnings.warn(group, participant, protection.reason, { messageId: message?.key?.id || null });
      result.warning = warning;
      if (warning.shouldEscalate && actorStateResult.isBotAdmin && typeof sock.sendMessage === 'function') {
        await sock.sendMessage(group, { delete: message.key });
        result.escalated = 'delete';
      }
      return result;
    }

    if (decision.action === 'delete') {
      if (!actorStateResult.isBotAdmin || typeof sock.sendMessage !== 'function') return { ...result, skipped: true, reason: 'bot-not-admin' };
      await sock.sendMessage(group, { delete: message.key });
      return { ...result, deleted: true };
    }

    if (decision.action === 'kick') {
      if (!actorStateResult.isBotAdmin || typeof sock.groupParticipantsUpdate !== 'function') return { ...result, skipped: true, reason: 'bot-not-admin' };
      await sock.groupParticipantsUpdate(group, [participant], 'remove');
      return { ...result, removed: true };
    }

    if (decision.action === 'block') {
      if (typeof sock.updateBlockStatus !== 'function') return { ...result, skipped: true, reason: 'block-api-unavailable' };
      await sock.updateBlockStatus(participant, 'block');
      return { ...result, blocked: true };
    }

    return { ...result, skipped: true, reason: 'unsupported-action' };
  }

  return {
    warnings,
    processMessage,
    actorState,
    decideCallAction,
  };
}

module.exports = { createLiveModeration, groupJid, isGroupMessage };