'use strict';

const net = require('net');
const { normalizeJid } = require('./target-resolver');

const MAX_GET_PATH = 256;
const MAX_FETCH_URL = 2048;
const MAX_REDIRECTS = 3;
const PUBLIC_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.google', 'instance-data.ec2.internal']);

function jid(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  const normalized = normalizeJid(input);
  if (!normalized || !normalized.includes('@')) return '';
  const [user, server] = normalized.split('@');
  if (!user || !server || user.length > 128 || server.length > 128) return '';
  if (!/^[a-zA-Z0-9._:-]+$/.test(user) || !/^[a-zA-Z0-9.-]+$/.test(server)) return '';
  return normalized;
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
  const path = String(propertyPath).trim();
  if (!path || path.length > MAX_GET_PATH) return fallback;
  const parts = path.split('.').filter(Boolean);
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
  const match = raw.match(/^(\S+)\s+(.+)$/s);
  if (!match) return { ok: false, reason: 'property-path-required' };
  const propertyPath = match[2].trim();
  if (!propertyPath || propertyPath.length > MAX_GET_PATH) return { ok: false, reason: 'invalid-property-path' };
  let source;
  try { source = JSON.parse(match[1]); } catch { source = match[1]; }
  return { ok: true, source, propertyPath };
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

function isUnsafeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) return isPrivateIpv4(host);
  if (net.isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

function fetchInput(value) {
  if (typeof value !== 'string') return { ok: false, value: null, reason: 'invalid-input' };
  const input = value.trim();
  if (!input) return { ok: false, value: null, reason: 'empty-input' };
  if (input.length > MAX_FETCH_URL) return { ok: false, value: input, reason: 'url-too-long' };
  let url;
  try { url = new URL(input); } catch { return { ok: false, value: input, reason: 'invalid-url' }; }
  if (!PUBLIC_PROTOCOLS.has(url.protocol)) return { ok: false, value: input, reason: 'unsupported-protocol' };
  if (url.username || url.password) return { ok: false, value: input, reason: 'credentials-not-allowed' };
  if (url.port && !['80', '443'].includes(url.port)) return { ok: false, value: input, reason: 'unsupported-port' };
  if (isUnsafeHost(url.hostname)) return { ok: false, value: input, reason: 'private-or-local-host-blocked' };
  return { ok: true, value: input, url };
}

function channelId(value) {
  if (typeof value !== 'string') return { ok: false, value: '', reason: 'invalid-input' };
  const input = value.trim();
  if (!input) return { ok: false, value: input, reason: 'empty-input' };
  if (/^\d+@newsletter$/i.test(input)) {
    const normalized = input.toLowerCase();
    return { ok: true, value: input, normalized, jid: normalized };
  }
  let url;
  try { url = new URL(input); } catch { return { ok: false, value: input, reason: 'invalid-channel-url' }; }
  if (url.protocol !== 'https:' || !/^(www\.)?whatsapp\.com$/i.test(url.hostname)) return { ok: false, value: input, reason: 'unsupported-channel-url' };
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'channel') return { ok: false, value: input, reason: 'invalid-channel-path' };
  let candidate;
  try { candidate = decodeURIComponent(parts[1]); } catch { return { ok: false, value: input, reason: 'invalid-channel-id' }; }
  if (!/^[A-Za-z0-9_-]{4,256}$/.test(candidate)) return { ok: false, value: input, reason: 'invalid-channel-id' };
  return { ok: true, value: input, normalized: candidate, jid: `${candidate}@newsletter` };
}

module.exports = { jid, lid, get, parseGetInput, fetchInput, channelId, isUnsafeHost, MAX_REDIRECTS };
