'use strict';

const fs = require('fs');
const path = require('path');

const API_FILE = path.resolve('./data/User APIs.json');
const DEFAULT_TIMEOUT = 30000;

function loadConfig(file = API_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { version: 1, defaults: { timeoutMs: DEFAULT_TIMEOUT, headers: {} }, providers: {} }; }
}
function enc(value) { return encodeURIComponent(String(value)); }
function tokenUrl(template, query) { return String(template || '').replace(/\{query\}/gi, enc(query)).replace(/\{raw\}/gi, String(query)); }

function buildRequest(provider, query, defaults = {}) {
  const template = String(provider.url || '');
  if (!template) throw new Error('No API URL is configured for this command.');
  const method = String(provider.method || 'GET').toUpperCase();
  const headers = { ...(defaults.headers || {}), ...(provider.headers || {}) };
  if (provider.token && !headers.authorization) headers.authorization = `Bearer ${provider.token}`;
  const options = { method, headers, redirect: 'follow' };
  let url = tokenUrl(template, query);
  const templated = /\{(?:query|raw)\}/i.test(template);
  if ((method === 'GET' || method === 'HEAD') && !templated) {
    const param = provider.queryParam === false ? '' : String(provider.queryParam || 'q');
    if (param) url += `${url.includes('?') ? '&' : '?'}${enc(param)}=${enc(query)}`;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    options.headers = { 'content-type': 'application/json', ...headers };
    const body = provider.body == null ? { query } : provider.body;
    options.body = JSON.stringify(typeof body === 'string' ? body.replace(/\{query\}/gi, String(query)) : body);
  }
  return { url, options };
}

function directUrls(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && !seen.has(value)) { seen.add(value); out.push(value); }
  } else if (Array.isArray(value)) value.forEach(v => directUrls(v, out, seen));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => directUrls(v, out, seen));
  return out;
}
function get(obj, paths) {
  for (const pathName of paths) {
    let value = obj;
    for (const part of pathName.split('.')) value = value?.[part];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return '';
}

function inferMedia(data, command) {
  const c = String(command).toLowerCase();
  const urls = directUrls(data);
  const direct = urls[0] || '';
  const imageCmd = /wallpaper|pinterest|ssweb|screenshot|sticker/.test(c);
  const audioCmd = /mp3|spotify|splay|song|play|shazam/.test(c);
  const videoCmd = /video|tiktok|facebook|fb|instagram|ig|twitter|xdl|twit|telegram/.test(c);
  const documentCmd = /apk|npm|gitclone|mediafire|tgpack/.test(c);
  const media = {
    audio: get(data,['audio','audio.url','result.audio','result.audio.url','data.audio','data.audio.url','download.audio','download.audio.url']),
    video: get(data,['video','video.url','result.video','result.video.url','data.video','data.video.url','download.video','download.video.url']),
    image: get(data,['image','image.url','photo','photo.url','thumbnail','thumbnail.url','result.image','result.image.url','data.image','data.image.url']),
    document: get(data,['document','document.url','file','file.url','result.file','result.file.url','download','download.url']),
    title: get(data,['title','name','result.title','data.title']),
    caption: get(data,['caption','description','result.caption','data.caption'])
  };
  if (data && typeof data === 'object') {
    const type = String(data.type || data.result?.type || data.data?.type || '').toLowerCase();
    if (!media.audio && type.includes('audio')) media.audio = direct;
    if (!media.video && type.includes('video')) media.video = direct;
    if (!media.image && (type.includes('image') || type.includes('photo'))) media.image = direct;
    if (!media.document && (type.includes('document') || type.includes('file'))) media.document = direct;
  }
  if (imageCmd && !media.image) media.image = direct;
  else if (audioCmd && !media.audio) media.audio = direct;
  else if (videoCmd && !media.video) media.video = direct;
  else if (documentCmd && !media.document) media.document = direct;
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
  const req = buildRequest(provider, query, config.defaults || {});
  const response = await fetchWithTimeout(req.url, req.options, Number(provider.timeoutMs || config.defaults?.timeoutMs || DEFAULT_TIMEOUT));
  const type = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  let data;
  if (type.includes('application/json')) data = await response.json();
  else if (type.startsWith('text/')) data = await response.text();
  else data = Buffer.from(await response.arrayBuffer());
  return { data, contentType: type, responseUrl: response.url, provider };
}
function isUrl(value) { return typeof value === 'string' && /^https?:\/\//i.test(value); }
function commandKind(command, media) {
  const c = String(command).toLowerCase();
  if (media.video) return 'video';
  if (media.audio) return 'audio';
  if (media.image) return 'image';
  if (media.document) return 'document';
  if (/sticker/.test(c)) return 'sticker';
  return 'document';
}

async function execute(command, query, send) {
  const result = await request(command, query);
  if (Buffer.isBuffer(result.data)) return send({ document: result.data, mimetype: result.contentType || 'application/octet-stream', fileName: `${command}.bin` }, { caption: `📥 ${command}` });
  if (typeof result.data === 'string') {
    if (isUrl(result.data)) {
      const media = inferMedia(result.data, command);
      const kind = commandKind(command, media);
      if (kind === 'video') return send({ video: { url: result.data }, mimetype: 'video/mp4' }, { caption: `📥 ${command}` });
      if (kind === 'audio') return send({ audio: { url: result.data }, mimetype: 'audio/mpeg' }, { caption: `📥 ${command}` });
      if (kind === 'image') return send({ image: { url: result.data } }, { caption: `📥 ${command}` });
      if (kind === 'sticker') return send({ sticker: { url: result.data } }, {});
      return send({ document: { url: result.data }, fileName: `${command}` }, { caption: `📥 ${command}` });
    }
    return send(null, { caption: `📥 ${command}\n${result.data.slice(0,3500)}` });
  }
  const media = inferMedia(result.data, command);
  const kind = commandKind(command, media);
  const url = media[kind];
  if (!isUrl(url)) return send(null, { caption: `📥 ${command}\n${JSON.stringify(result.data).slice(0,3500)}` });
  const caption = media.title || media.caption || `📥 ${command}`;
  if (kind === 'audio') return send({ audio: { url }, mimetype: 'audio/mpeg' }, { caption });
  if (kind === 'video') return send({ video: { url }, mimetype: 'video/mp4' }, { caption });
  if (kind === 'image') return send({ image: { url } }, { caption });
  if (kind === 'sticker') return send({ sticker: { url } }, {});
  return send({ document: { url }, mimetype: result.contentType || 'application/octet-stream', fileName: `${command}` }, { caption });
}
module.exports={API_FILE,loadConfig,buildRequest,inferMedia,request,execute};
