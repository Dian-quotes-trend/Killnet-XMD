'use strict';

const fs = require('fs');
const path = require('path');

const API_FILE = path.resolve('./data/User APIs.json');
const DEFAULT_TIMEOUT = 30000;

function loadConfig(file = API_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, defaults: { timeoutMs: DEFAULT_TIMEOUT, headers: {} }, providers: {} };
  }
}

function encode(value) { return encodeURIComponent(String(value)); }
function replaceTokens(template, query) {
  return String(template || '').replace(/\{query\}/gi, encode(query)).replace(/\{raw\}/gi, String(query));
}

function buildRequest(provider, query, defaults = {}) {
  const url = replaceTokens(provider.url, query);
  if (!url) throw new Error('No API URL is configured for this command.');
  const method = String(provider.method || 'GET').toUpperCase();
  const headers = { ...(defaults.headers || {}), ...(provider.headers || {}) };
  if (provider.token && !headers.authorization) headers.authorization = `Bearer ${provider.token}`;
  const options = { method, headers, redirect: 'follow' };
  if (method === 'GET' || method === 'HEAD') {
    if (!url.includes('{query}') && !url.includes('{raw}')) {
      const param = provider.queryParam === false ? '' : String(provider.queryParam || 'q');
      if (param) return { url: `${url}${url.includes('?') ? '&' : '?'}${encode(param)}=${encode(query)}`, options };
    }
  } else {
    options.headers = { 'content-type': 'application/json', ...headers };
    options.body = JSON.stringify(provider.body || { query });
  }
  return { url, options };
}

function collectUrls(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && !seen.has(value)) { seen.add(value); out.push(value); }
    return out;
  }
  if (Array.isArray(value)) { for (const item of value) collectUrls(item, out, seen); return out; }
  if (value && typeof value === 'object') for (const item of Object.values(value)) collectUrls(item, out, seen);
  return out;
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let value = obj;
    for (const part of parts) value = value?.[part];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function inferMedia(data, command) {
  const media = {
    audio: pickFirst(data, ['audio','audio.url','result.audio','result.audio.url','data.audio','data.audio.url','download.audio','download.audio.url','url']),
    video: pickFirst(data, ['video','video.url','result.video','result.video.url','data.video','data.video.url','download.video','download.video.url']),
    image: pickFirst(data, ['image','image.url','thumbnail','thumbnail.url','result.image','result.image.url','data.image','data.image.url']),
    document: pickFirst(data, ['document','document.url','file','file.url','result.file','result.file.url','download','download.url']),
    title: pickFirst(data, ['title','name','result.title','data.title']),
    caption: pickFirst(data, ['caption','description','result.caption','data.caption'])
  };
  const urls = collectUrls(data);
  const direct = urls[0] || '';
  const lower = String(command).toLowerCase();
  if (!media.video && /video|tiktok|facebook|instagram|twitter|xdl|twit|telegram/.test(lower)) media.video = direct;
  if (!media.audio && /mp3|spotify|splay|song|play|shazam/.test(lower)) media.audio = direct;
  if (!media.image && /wallpaper|pinterest|ssweb|screenshot|sticker/.test(lower)) media.image = direct;
  if (!media.document && /apk|npm|gitclone|mediafire|tgpack/.test(lower)) media.document = direct;
  return media;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function request(command, query, file = API_FILE) {
  const config = loadConfig(file);
  const provider = config.providers?.[command];
  if (!provider || typeof provider !== 'object' || !provider.url) throw new Error(`No API configured for ${command}. Add it to data/User APIs.json.`);
  const { url, options } = buildRequest(provider, query, config.defaults || {});
  const response = await fetchWithTimeout(url, options, Number(provider.timeoutMs || config.defaults?.timeoutMs || DEFAULT_TIMEOUT));
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  let data;
  if (contentType.includes('application/json')) data = await response.json();
  else if (contentType.startsWith('text/')) data = await response.text();
  else data = new Uint8Array(await response.arrayBuffer());
  return { data, contentType, responseUrl: response.url, provider };
}

function isDirectUrl(value) { return typeof value === 'string' && /^https?:\/\//i.test(value); }
function mediaKind(command, media, contentType) {
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('image/')) return 'image';
  const lower = String(command).toLowerCase();
  if (media.audio) return 'audio';
  if (media.video) return 'video';
  if (media.image) return 'image';
  if (media.document) return 'document';
  if (/sticker/.test(lower)) return 'sticker';
  return 'document';
}

async function execute(command, query, send) {
  const result = await request(command, query);
  if (result.data instanceof Uint8Array) {
    return send({ document: Buffer.from(result.data), mimetype: result.contentType || 'application/octet-stream', fileName: `${command}.bin` }, { caption: `📥 ${command}` });
  }
  if (typeof result.data === 'string') return send(null, { caption: `📥 ${command}\n${result.data.slice(0, 3500)}` });
  const media = inferMedia(result.data, command);
  const kind = mediaKind(command, media, result.contentType);
  const url = media[kind] || result.responseUrl;
  if (!isDirectUrl(url)) return send(null, { caption: `📥 ${command}\n${JSON.stringify(result.data).slice(0, 3500)}` });
  const caption = media.title || media.caption || `📥 ${command}`;
  if (kind === 'audio') return send({ audio: { url }, mimetype: 'audio/mpeg' }, { caption });
  if (kind === 'video') return send({ video: { url }, mimetype: 'video/mp4' }, { caption });
  if (kind === 'image') return send({ image: { url } }, { caption });
  if (kind === 'sticker') return send({ sticker: { url } }, {});
  return send({ document: { url }, mimetype: result.contentType || 'application/octet-stream', fileName: `${command}` }, { caption });
}

module.exports = { API_FILE, loadConfig, buildRequest, inferMedia, request, execute };
