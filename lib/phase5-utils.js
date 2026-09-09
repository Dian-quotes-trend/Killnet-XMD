'use strict';

const { normalizeJid } = require('./target-resolver');

function jid(value) {
  return normalizeJid(value);
}

function lid(value) {
  const normalized = normalizeJid(value);
  return normalized.endsWith('@lid') ? normalized : '';
}

function get(value, path, fallback = null) {
  if (!path) return value;
  const parts = String(path).split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) return fallback;
    current = current[part];
  }
  return current;
}

function fetchInput(value) {
  if (typeof value !== 'string') return { ok: false, value: null, reason: 'invalid-input' };
  const input = value.trim();
  if (!input) return { ok: false, value: null, reason: 'empty-input' };
  return { ok: true, value: input };
}

function channelId(value) {
  const input = fetchInput(value);
  if (!input.ok) return input;
  return { ok: true, value: input.value, normalized: input.value.replace(/^https?:\/\//i, '').replace(/\/$/, '') };
}

module.exports = { jid, lid, get, fetchInput, channelId };
