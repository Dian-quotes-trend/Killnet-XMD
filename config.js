// Killnet XMD — Bot Server Configuration
// Creator: Dian Sybex Tech

const fs = require('fs');
const path = require('path');

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
})();

const pick = (key, fallback = '') => {
  const value = process.env[key];
  return value !== undefined && String(value).trim() !== '' ? String(value).trim() : fallback;
};

// Keep application console logs visible. Baileys itself is kept quiet through pino.
if (process.env.BAILEYS_LOG_LEVEL === undefined) process.env.BAILEYS_LOG_LEVEL = 'silent';

let pairMode = pick('PAIR_MODE', '').toLowerCase();
if (!pairMode) pairMode = process.env.USE_PAIRING_CODE === 'false' ? 'qr' : 'code';
if (!['code', 'qr', 'both'].includes(pairMode)) pairMode = 'code';

module.exports = {
  botName: pick('BOT_NAME', 'Killnet XMD'),
  creator: 'Dian Sybex Tech',
  ownerNumber: pick('OWNER_NUMBER').replace(/[^0-9]/g, ''),
  masterSudo: pick('MASTER_SUDO').replace(/[^0-9]/g, ''),
  timezone: pick('TIMEZONE', 'Africa/Kampala'),
  packName: pick('PACK_NAME', 'Killnet XMD'),
  author: pick('AUTHOR', 'Dian Sybex Tech'),
  prefix: pick('PREFIX', '.'),

  dashboardUserId: '',
  dashboardEnabled: false,
  apiPort: Number(pick('PORT', 3001)),

  sessionFolder: './session',
  credsFile: './session/creds.json',
  pairMode,
  usePairingCode: pairMode !== 'qr',
  showQr: pairMode !== 'code',
};
