// Killnet XMD — Phase 1A centralized target resolver
// Pure target resolution: no network calls, no feature behavior.

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeJid(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (raw.includes('@')) {
    try { return jidNormalizedUser(raw); } catch { return raw; }
  }
  const number = digits(raw);
  return number ? `${number}@s.whatsapp.net` : '';
}

function phoneOf(value) {
  return digits(String(value || '').split('@')[0]);
}

function identityCandidates(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    const jid = normalizeJid(value);
    const phone = phoneOf(value);
    return [...new Set([jid, phone].filter(Boolean))];
  }

  const values = [
    value.id, value.jid, value.lid, value.phoneNumber, value.phone,
    value.participant, value.participantAlt, value.participantPn,
    value.senderPn, value.remoteJid, value.remoteJidAlt,
  ].filter(Boolean);

  const out = [];
  for (const item of values) {
    const jid = normalizeJid(item);
    const phone = phoneOf(item);
    if (jid) out.push(jid);
    if (phone) out.push(phone);
  }
  return [...new Set(out)];
}

function participantRecord(participant) {
  const source = participant || {};
  const jid = normalizeJid(source.id || source.jid || source.participant || source.phoneNumber);
  const candidates = identityCandidates(source);
  return {
    ...source,
    jid,
    candidates,
    admin: source.admin || null,
  };
}

function createParticipantIndex(participants = []) {
  const byIdentity = new Map();
  const records = participants.filter(Boolean).map(participantRecord);

  for (const record of records) {
    for (const identity of record.candidates) {
      if (!byIdentity.has(identity)) byIdentity.set(identity, []);
      byIdentity.get(identity).push(record);
    }
  }

  return { records, byIdentity };
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = record.jid || record.id || record.candidates.join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lookup(input, index) {
  const candidates = identityCandidates(input);
  const matches = uniqueRecords(candidates.flatMap((identity) => index.byIdentity.get(identity) || []));
  if (matches.length === 1) return { ok: true, target: matches[0] };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', targets: matches };
  return { ok: false, reason: 'not-found', targets: [] };
}

function resolveTarget(input, participants = [], options = {}) {
  const index = options.index || createParticipantIndex(participants);
  if (!input || (typeof input === 'string' && !input.trim())) return { ok: false, reason: 'invalid-target', targets: [], source: options.source || 'argument' };
  const result = lookup(input, index);
  return result.ok
    ? { ok: true, target: result.target, targets: [result.target], source: options.source || 'argument' }
    : { ...result, source: options.source || 'argument' };
}

function resolveTargets(inputs = [], participants = [], options = {}) {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const index = options.index || createParticipantIndex(participants);
  const targets = [];
  const unresolved = [];
  const seen = new Set();

  for (const input of values) {
    const result = resolveTarget(input, participants, { ...options, index });
    if (result.ok) {
      const key = result.target.jid || result.target.id;
      if (!seen.has(key)) { seen.add(key); targets.push(result.target); }
    } else {
      unresolved.push({ input, reason: result.reason, targets: result.targets || [] });
    }
  }

  return {
    ok: targets.length > 0 && unresolved.length === 0,
    targets,
    unresolved,
    reason: targets.length ? (unresolved.length ? 'partial' : null) : (unresolved[0]?.reason || 'no-target'),
    source: options.source || 'argument',
  };
}

function resolveFromContext(ctx = {}, participants = [], options = {}) {
  const index = options.index || createParticipantIndex(participants);
  const mentions = Array.isArray(ctx.mentionedJids) ? ctx.mentionedJids : [];
  if (mentions.length) return resolveTargets(mentions, participants, { ...options, index, source: 'mention' });

  const quotedParticipant = ctx.quoted?.participant || ctx.quoted?.participantAlt;
  if (quotedParticipant) return resolveTarget(quotedParticipant, participants, { ...options, index, source: 'quote' });

  const args = Array.isArray(ctx.args) ? ctx.args : [];
  if (args.length) return resolveTargets(args, participants, { ...options, index, source: 'argument' });

  if (options.includeSender && ctx.senderId) return resolveTarget(ctx.senderId, participants, { ...options, index, source: 'sender' });

  return { ok: false, reason: 'no-target', targets: [], unresolved: [], source: 'none' };
}

module.exports = {
  digits,
  normalizeJid,
  phoneOf,
  identityCandidates,
  participantRecord,
  createParticipantIndex,
  resolveTarget,
  resolveTargets,
  resolveFromContext,
};
