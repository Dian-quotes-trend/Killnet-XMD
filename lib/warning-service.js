// Killnet XMD — Phase 1E warning and moderation service
// Persistent warning state is injected so moderation stays independent from storage.

function normalizeJid(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWarningState(state) {
  const source = state && typeof state === 'object' ? state : {};
  const groups = source.groups && typeof source.groups === 'object' ? source.groups : {};
  const normalized = { version: 1, groups: {} };

  for (const [groupJid, group] of Object.entries(groups)) {
    if (!group || typeof group !== 'object') continue;
    const users = group.users && typeof group.users === 'object' ? group.users : {};
    normalized.groups[groupJid] = { users: {} };

    for (const [userJid, record] of Object.entries(users)) {
      if (!record || typeof record !== 'object') continue;
      const history = Array.isArray(record.history) ? record.history : [];
      const count = Number.isInteger(record.count) && record.count >= 0
        ? record.count
        : history.length;
      normalized.groups[groupJid].users[userJid] = {
        count,
        history: history.map((item) => ({
          reason: String(item?.reason || ''),
          timestamp: item?.timestamp || null,
          metadata: item?.metadata && typeof item.metadata === 'object' ? { ...item.metadata } : {},
        })),
        updatedAt: record.updatedAt || null,
      };
    }
  }

  return normalized;
}

function groupRecord(state, groupJid) {
  if (!state.groups[groupJid]) state.groups[groupJid] = { users: {} };
  return state.groups[groupJid];
}

function userRecord(state, groupJid, userJid) {
  const group = groupRecord(state, groupJid);
  if (!group.users[userJid]) group.users[userJid] = { count: 0, history: [], updatedAt: null };
  return group.users[userJid];
}

function createWarningStore({ db, key = 'moderation.warnings', maxWarnings = 3, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.set !== 'function') {
    throw new Error('A database adapter with get/set is required.');
  }

  const threshold = Math.max(1, Number(maxWarnings) || 3);

  async function load() {
    return normalizeWarningState(await db.get(key, { version: 1, groups: {} }));
  }

  async function save(state) {
    const normalized = normalizeWarningState(state);
    await db.set(key, normalized);
    return normalized;
  }

  async function get(groupJid, userJid) {
    const group = normalizeJid(groupJid);
    const user = normalizeJid(userJid);
    if (!group || !user) return { count: 0, history: [], updatedAt: null };
    const state = await load();
    const record = state.groups[group]?.users?.[user];
    return record ? { ...record, history: [...record.history] } : { count: 0, history: [], updatedAt: null };
  }

  async function warn(groupJid, userJid, reason = '', metadata = {}) {
    const group = normalizeJid(groupJid);
    const user = normalizeJid(userJid);
    if (!group || !group.endsWith('@g.us')) throw new Error('A valid group JID is required.');
    if (!user) throw new Error('A valid user JID is required.');

    const state = await load();
    const record = userRecord(state, group, user);
    const timestamp = now();
    record.count += 1;
    record.updatedAt = timestamp;
    record.history.push({
      reason: String(reason || ''),
      timestamp,
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
    });

    const action = record.count >= threshold ? 'threshold' : 'warn';
    await save(state);
    return {
      groupJid: group,
      userJid: user,
      count: record.count,
      threshold,
      action,
      shouldEscalate: action === 'threshold',
      history: [...record.history],
    };
  }

  async function reset(groupJid, userJid) {
    const group = normalizeJid(groupJid);
    const user = normalizeJid(userJid);
    const state = await load();
    if (state.groups[group]?.users) delete state.groups[group].users[user];
    await save(state);
    return { groupJid: group, userJid: user, count: 0, history: [] };
  }

  async function clearGroup(groupJid) {
    const group = normalizeJid(groupJid);
    const state = await load();
    delete state.groups[group];
    await save(state);
    return { groupJid: group, cleared: true };
  }

  return { threshold, load, save, get, warn, reset, clearGroup };
}

function moderationDecision({ warningCount = 0, threshold = 3, action = 'warn' } = {}) {
  const count = Math.max(0, Number(warningCount) || 0);
  const limit = Math.max(1, Number(threshold) || 3);
  if (count >= limit) return { action: 'threshold', count, threshold: limit };
  return { action: String(action || 'warn'), count, threshold: limit };
}

module.exports = {
  normalizeWarningState,
  createWarningStore,
  moderationDecision,
};
