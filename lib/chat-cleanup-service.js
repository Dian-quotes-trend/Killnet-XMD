// Killnet XMD — Phase 1G chat cleanup service
// Builds safe deletion plans. The caller supplies authorized message keys.

function isValidMessageKey(key) {
  return Boolean(key && typeof key === 'object' && key.remoteJid && key.id);
}

function uniqueMessageKeys(keys = []) {
  const seen = new Set();
  const result = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!isValidMessageKey(key)) continue;
    const fingerprint = `${key.remoteJid}:${key.id}:${key.participant || ''}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(key);
  }
  return result;
}

function buildClearChatPlan(keys, options = {}) {
  const messageKeys = uniqueMessageKeys(keys);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : messageKeys.length;
  return {
    action: 'delete',
    keys: messageKeys.slice(0, limit),
    skipped: Math.max(0, messageKeys.length - limit),
  };
}

async function clearChat(sock, keys, options = {}) {
  if (!sock || typeof sock.sendMessage !== 'function') {
    const error = new Error('WhatsApp socket sendMessage is unavailable.');
    error.code = 'SOCKET_METHOD_UNAVAILABLE';
    throw error;
  }
  const plan = buildClearChatPlan(keys, options);
  const results = [];
  for (const key of plan.keys) {
    results.push(await sock.sendMessage(key.remoteJid, { delete: key }));
  }
  return { ...plan, results };
}

module.exports = {
  isValidMessageKey,
  uniqueMessageKeys,
  buildClearChatPlan,
  clearChat,
};
