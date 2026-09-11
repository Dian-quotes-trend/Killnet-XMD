'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve('./data');
const AUTOMATION_FILE = path.join(DATA_DIR, 'automation.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function migratePhase4LegacyState() {
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  const autoreplyFile = path.join(DATA_DIR, 'autoreply.json');
  const anticallFile = path.join(DATA_DIR, 'anticall.json');
  const antilinkFile = path.join(DATA_DIR, 'antilink.json');

  const settings = readJson(settingsFile, {});
  const autoreply = readJson(autoreplyFile, {});
  const anticall = readJson(anticallFile, {});
  const legacyAntilink = readJson(antilinkFile, []);
  const automation = readJson(AUTOMATION_FILE, {});
  const current = automation['automation.config'] && typeof automation['automation.config'] === 'object'
    ? automation['automation.config']
    : {};

  const next = {
    global: { ...(current.global || {}) },
    groups: { ...(current.groups || {}) },
    status: { ...(current.status || {}) },
    chatbot: { ...(current.chatbot || {}), chats: { ...((current.chatbot || {}).chats || {}) } },
    autoreply: { ...(current.autoreply || {}) },
    anticall: { ...(current.anticall || {}) },
  };

  if (Object.prototype.hasOwnProperty.call(settings, 'autoRead')) next.global.autoread = Boolean(settings.autoRead);
  if (Object.prototype.hasOwnProperty.call(settings, 'autoReact')) next.global.autoreact = Boolean(settings.autoReact);
  if (Object.prototype.hasOwnProperty.call(settings, 'presenceMode')) next.global.presence = settings.presenceMode !== 'off';
  if (Object.prototype.hasOwnProperty.call(settings, 'autoStatusView')) next.status.autoview = Boolean(settings.autoStatusView);
  if (Object.prototype.hasOwnProperty.call(settings, 'autoLikeStatus')) next.status.autolike = Boolean(settings.autoLikeStatus);
  if (Object.prototype.hasOwnProperty.call(settings, 'autoStatusSave')) next.status.autosave = Boolean(settings.autoStatusSave);

  if (autoreply && typeof autoreply === 'object' && Object.keys(autoreply).length) {
    next.autoreply = { ...next.autoreply, ...autoreply };
  } else if (settings.autoReply && typeof settings.autoReply === 'object') {
    next.autoreply = { ...next.autoreply, ...settings.autoReply };
  }

  if (anticall && typeof anticall === 'object' && Object.keys(anticall).length) {
    next.anticall = { ...next.anticall, ...anticall };
  } else if (settings.antiCall && typeof settings.antiCall === 'object') {
    next.anticall = { ...next.anticall, ...settings.antiCall };
  }

  if (Array.isArray(legacyAntilink)) {
    for (const group of legacyAntilink) {
      if (typeof group !== 'string' || !group.endsWith('@g.us')) continue;
      next.groups[group] = {
        ...(next.groups[group] || {}),
        antilink: { enabled: true, action: 'delete', ...((next.groups[group] || {}).antilink || {}) },
      };
    }
  }

  writeJson(AUTOMATION_FILE, { ...automation, 'automation.config': next });

  if (settings && typeof settings === 'object') {
    const cleaned = { ...settings };
    for (const key of ['autoRead', 'autoReact', 'autoReply', 'antiCall', 'presenceMode', 'autoStatusView', 'autoLikeStatus', 'autoStatusSave']) delete cleaned[key];
    writeJson(settingsFile, cleaned);
  }

  for (const file of [autoreplyFile, anticallFile, antilinkFile]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

migratePhase4LegacyState();

module.exports = { migratePhase4LegacyState };
