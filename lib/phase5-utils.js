'use strict';

const { normalizeJid } = require('./target-resolver');

function jid(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  return normalizeJid(input);
}

function lid(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  if (/^\d+@lid$/i.test(input)) return input.toLowerCase();
  if (/^lid:\d+$/i.test(input)) return `${input.slice(4)}@lid`;
  return '';
}

function get(value, propertyPath, fallback = null) {
  if (!propertyPath) return value;
  const parts = String(propertyPath).split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return fallback;
    current = current[part];
  }
  return current;
}

function parseGetInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty-input' };
  const separator = raw.search(/\s+/);
  if (separator < 0) return { ok: false, reason: 'property-path-required' };
  const sourceText = raw.slice(0, separator).trim();
  const propertyPath = raw.slice(separator).trim();
  let source;
  try { source = JSON.parse(sourceText); } catch { source = sourceText; }
  return { ok: true, source, propertyPath };
}

function fetchInput(value) {
  if (typeof value !== 'string') return { ok: false, value: null, reason: 'invalid-input' };
  const input = value.trim();
  if (!input) return { ok: false, value: null, reason: 'empty-input' };
  let url;
  try { url = new URL(input); } catch { return { ok: false, value: input, reason: 'invalid-url' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, value: input, reason: 'unsupported-protocol' };
  return { ok: true, value: input, url };
}

function channelId(value) {
  const input = fetchInput(value);
  if (!input.ok) return input;
  const url = input.url;
  const pathParts = url.pathname.split('/').filter(Boolean);
  const candidate = pathParts[pathParts.length - 1] || url.hostname;
  const decoded = decodeURIComponent(candidate);
  if (!decoded || decoded.includes('@') || decoded.length > 256) return { ok: false, value: input.value, reason: 'invalid-channel-id' };
  return { ok: true, value: input.value, normalized: decoded, jid: decoded.endsWith('@newsletter') ? decoded : `${decoded}@newsletter` };
}

module.exports = { jid, lid, get, parseGetInput, fetchInput, channelId };
