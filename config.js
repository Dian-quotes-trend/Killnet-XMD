// W-MD Bot Server Configuration
// Standalone runtime: no dashboard/API/cloud connection.

const fs = require('fs');
const path = require('path');

// ─── Minimal .env loader ────────────────────────────────────────
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (e) {
    // Configuration loading should never spam stdout.
  }
})();

const pick = (key, fallback = '') => {
  const value = process.env[key];
  return value !== undefined && String(value).trim() !== ''
    ? String(value).trim()
    : fallback;
};

// ─── Standalone logging policy ──────────────────────────────────
// Keep the terminal quiet. Pairing codes remain visible because they are
// required for first-time authentication. Set QUIET_LOGS=false to restore
// normal stdout logging when debugging locally.
if (pick('QUIET_LOGS', 'true').toLowerCase() !== 'false') {
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);

  const quiet = (original) => (...args) => {
    const text = args.map((arg) => String(arg)).join(' ');
    if (/PAIRING CODE/i.test(text)) return original(...args);
  };

  console.log = quiet(originalLog);
  console.info = quiet(originalInfo);
  console.warn = quiet(originalWarn);
}

// Baileys can be verbose even when application logging is quiet.
if (process.env.BAILEYS_LOG_LEVEL === undefined) {
  process.env.BAILEYS_LOG_LEVEL = 'silent';
}

let pairMode = pick('PAIR_MODE', '').toLowerCase();
if (!pairMode) pairMode = process.env.USE_PAIRING_CODE === 'false' ? 'qr' : 'code';
if (!['code', 'qr', 'both'].includes(pairMode)) pairMode = 'code';

module.exports = {
  botName: pick('BOT_NAME', 'W-MD Bot'),
  ownerNumber: pick('OWNER_NUMBER').replace(/[^0-9]/g, ''),
  timezone: pick('TIMEZONE', 'Africa/Kampala'),
  packName: pick('PACK_NAME', 'W-MD'),
  author: pick('AUTHOR', 'W-MD Bot'),

  // Dashboard/cloud integration is intentionally disabled in the standalone build.
  dashboardUserId: '',
  dashboardEnabled: false,

  // Kept for backwards compatibility with index.js; api.js is now a no-op shim.
  apiPort: Number(pick('PORT', 3001)),

  sessionFolder: './session',
  credsFile: './session/creds.json',

  pairMode,
  usePairingCode: pairMode !== 'qr',
  showQr: pairMode !== 'code',
};
