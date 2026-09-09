// Killnet XMD — Phase 1G group-status service
// Separates status-post construction from command/event handlers.

const STATUS_JID = 'status@broadcast';

function assertGroupJid(groupJid) {
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) {
    const error = new Error('A group JID is required.');
    error.code = 'INVALID_GROUP';
    throw error;
  }
}

function buildGroupStatusPayload(text, options = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Status text cannot be empty.');
  const mentions = Array.isArray(options.mentions) ? [...new Set(options.mentions.filter(Boolean))] : [];
  return { text: body, mentions };
}

function buildGroupStatusRequest(groupJid, text, options = {}) {
  assertGroupJid(groupJid);
  return {
    jid: STATUS_JID,
    payload: buildGroupStatusPayload(text, options),
    statusJid: STATUS_JID,
    groupJid,
  };
}

module.exports = {
  STATUS_JID,
  assertGroupJid,
  buildGroupStatusPayload,
  buildGroupStatusRequest,
};
