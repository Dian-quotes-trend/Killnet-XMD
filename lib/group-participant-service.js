// Killnet XMD — Phase 1C group participant management service
// Centralizes add/remove/promote/demote operations and group-role checks.

const { resolveGroupTargets, loadGroupParticipants } = require('./group-target-service');
const { normalizeJid, phoneOf } = require('./target-resolver');

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

function isAdminParticipant(participant) {
  return ADMIN_ROLES.has(participant?.admin);
}

function participantIdentity(participant) {
  return participant?.id || participant?.jid || participant?.participant || '';
}

function sameIdentity(a, b) {
  return Boolean(a && b) && (
    a === b ||
    phoneOf(a) === phoneOf(b)
  );
}

function findParticipant(participants, jid) {
  return participants.find((participant) => sameIdentity(participantIdentity(participant), jid)) || null;
}

function getGroupRoleState(participants, actorJid, botJid) {
  const actor = findParticipant(participants, actorJid);
  const bot = findParticipant(participants, botJid);
  return {
    actor,
    bot,
    actorIsAdmin: isAdminParticipant(actor),
    botIsAdmin: isAdminParticipant(bot),
  };
}

function assertGroupAdmin(state) {
  if (!state.actorIsAdmin) {
    const error = new Error('Group admin access required.');
    error.code = 'ACTOR_NOT_ADMIN';
    throw error;
  }
  if (!state.botIsAdmin) {
    const error = new Error('Bot must be a group admin.');
    error.code = 'BOT_NOT_ADMIN';
    throw error;
  }
}

async function groupRoleState(sock, groupJid, actorJid) {
  const participants = await loadGroupParticipants(sock, groupJid);
  const botJid = typeof sock?.user?.id === 'string' ? normalizeJid(sock.user.id) : '';
  return getGroupRoleState(participants, actorJid, botJid);
}

async function resolveManagedTargets(sock, groupJid, inputs, options = {}) {
  return resolveGroupTargets(sock, groupJid, inputs, options);
}

function normalizeAddTargets(inputs = []) {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const seen = new Set();
  const targets = [];
  const unresolved = [];

  for (const input of values) {
    const jid = normalizeJid(input);
    if (!jid || !jid.endsWith('@s.whatsapp.net')) {
      unresolved.push({ input, reason: 'invalid-target', targets: [] });
      continue;
    }
    if (!seen.has(jid)) {
      seen.add(jid);
      targets.push({ jid, id: jid, candidates: [jid, phoneOf(jid)] });
    }
  }

  return {
    ok: targets.length > 0 && unresolved.length === 0,
    targets,
    unresolved,
    reason: targets.length ? (unresolved.length ? 'partial' : null) : 'no-target',
    source: 'argument',
  };
}

async function manageParticipants(sock, groupJid, actorJid, inputs, action) {
  const allowed = new Set(['add', 'remove', 'promote', 'demote']);
  if (!allowed.has(action)) throw new Error(`Unsupported participant action: ${action}`);

  const state = await groupRoleState(sock, groupJid, actorJid);
  assertGroupAdmin(state);

  const result = action === 'add'
    ? normalizeAddTargets(inputs)
    : await resolveManagedTargets(sock, groupJid, inputs, { source: 'argument' });

  if (!result.ok) {
    const error = new Error(result.reason === 'ambiguous' ? 'Target is ambiguous.' : 'No valid group target found.');
    error.code = 'TARGET_RESOLUTION_FAILED';
    error.result = result;
    throw error;
  }

  const jids = result.targets.map(participantIdentity).filter(Boolean);
  if (!jids.length) throw new Error('No valid participant targets found.');

  const response = await sock.groupParticipantsUpdate(groupJid, jids, action);
  return { action, targets: result.targets, jids, response };
}

module.exports = {
  ADMIN_ROLES,
  isAdminParticipant,
  participantIdentity,
  findParticipant,
  getGroupRoleState,
  assertGroupAdmin,
  groupRoleState,
  resolveManagedTargets,
  normalizeAddTargets,
  manageParticipants,
};
