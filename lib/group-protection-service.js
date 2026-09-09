// Killnet XMD — Phase 1F group protection service
// Pure protection decisions. Transport actions remain outside this module.

const LINK_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function containsLink(text) {
  return LINK_PATTERN.test(String(text || ''));
}

function normalizeAction(action, fallback = 'warn') {
  const value = String(action || '').trim().toLowerCase();
  return ['warn', 'delete', 'kick', 'block', 'ignore'].includes(value) ? value : fallback;
}

function createProtectionPolicy(options = {}) {
  const groups = options.groups || {};
  const getGroup = (jid) => groups[jid] || {};

  function policyFor(groupJid, type) {
    if (!isGroupJid(groupJid)) return { enabled: false, action: 'ignore' };
    const policy = getGroup(groupJid)?.[type];
    if (!policy || policy.enabled !== true) return { enabled: false, action: 'ignore' };
    return { enabled: true, action: normalizeAction(policy.action) };
  }

  return {
    antilink(groupJid, text, actor = {}) {
      const policy = policyFor(groupJid, 'antilink');
      if (!policy.enabled || actor.isAdmin || actor.isPrivileged || actor.isFromMe) {
        return { matched: false, ...policy, reason: 'exempt' };
      }
      return { matched: containsLink(text), ...policy, reason: containsLink(text) ? 'link-detected' : 'no-link' };
    },

    antistatus(groupJid, event = {}, actor = {}) {
      const policy = policyFor(groupJid, 'antistatus');
      if (!policy.enabled || actor.isAdmin || actor.isPrivileged || actor.isFromMe) {
        return { matched: false, ...policy, reason: 'exempt' };
      }
      const matched = Boolean(event.isStatus || event.messageType === 'status' || event.isGroupStatus);
      return { matched, ...policy, reason: matched ? 'status-detected' : 'not-status' };
    },

    get(groupJid, type) {
      return policyFor(groupJid, type);
    },
  };
}

function decideCallAction(options = {}) {
  const enabled = options.enabled === true;
  if (!enabled) return { enabled: false, action: 'ignore' };
  const action = String(options.action || 'reject').toLowerCase();
  return {
    enabled: true,
    action: ['reject', 'block', 'ignore'].includes(action) ? action : 'reject',
    message: String(options.message || ''),
  };
}

function decideProtection(result) {
  if (!result?.matched) return { execute: false, action: 'ignore', reason: result?.reason || 'not-matched' };
  return { execute: true, action: normalizeAction(result.action), reason: result.reason };
}

module.exports = {
  LINK_PATTERN,
  isGroupJid,
  containsLink,
  normalizeAction,
  createProtectionPolicy,
  decideCallAction,
  decideProtection,
};
