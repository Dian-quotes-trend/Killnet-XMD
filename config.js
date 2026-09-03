// ═══════════════════════════════════════════════════════════════
// W-MD Bot Server Configuration
//
// Values are resolved in this order (first one found wins):
//   1. Hosting panel / process environment variables
//   2. A `.env` file next to this script (read with a tiny built-in
//      parser — no dotenv dependency required)
//   3. The HARDCODED fallbacks below (edit these if your host has no
//      env panel — you never need to touch index.js)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ─── Minimal .env loader (does not override real env vars) ──────
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
    console.warn('⚠️ Could not read .env:', e.message);
  }
})();

// ─── HARDCODED FALLBACKS (optional) ─────────────────────────────
// Fill these in if you don't want to use env vars at all.
const HARDCODED = {
  DASHBOARD_USER_ID: '',   // ← paste your Dashboard ID here (Settings → Dashboard ID)
  OWNER_NUMBER: '',        // ← e.g. 2567xxxxxxxx (country code, digits only)
  PAIR_MODE: 'code',       // 'code' (8-digit, default) | 'qr' | 'both'
};

const pick = (key, fallback = '') => {
  const v = process.env[key];
  if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  if (HARDCODED[key] !== undefined && String(HARDCODED[key]).trim() !== '') return String(HARDCODED[key]).trim();
  return fallback;
};

// ─── Pairing mode ───────────────────────────────────────────────
// PAIR_MODE=code  → 8-digit pairing code only (QR hidden)      [default]
// PAIR_MODE=qr    → QR code only (no pairing-code prompt)
// PAIR_MODE=both  → code first, QR shown as a fallback
// Legacy: USE_PAIRING_CODE=false is treated as PAIR_MODE=qr.
let pairMode = pick('PAIR_MODE', '').toLowerCase();
if (!pairMode) pairMode = process.env.USE_PAIRING_CODE === 'false' ? 'qr' : 'code';
if (!['code', 'qr', 'both'].includes(pairMode)) pairMode = 'code';

const dashboardUserId = pick('DASHBOARD_USER_ID');

module.exports = {
  // Bot settings
  botName: pick('BOT_NAME', 'W-MD Bot'),
  ownerNumber: pick('OWNER_NUMBER').replace(/[^0-9]/g, ''),
  timezone: pick('TIMEZONE', 'Africa/Kampala'),
  packName: pick('PACK_NAME', 'W-MD'),
  author: pick('AUTHOR', 'W-MD Bot'),

  // Dashboard link (cloud sync). Required for the web dashboard to work.
  dashboardUserId,

  // Session folder
  sessionFolder: './session',
  credsFile: './session/creds.json',

  // Local API / websocket port (CORS is open — the dashboard is identified by
  // its Dashboard ID, not by origin, so no DASHBOARD_URL is needed)
  apiPort: Number(pick('PORT', 3001)),

  // Pairing
  pairMode,
  usePairingCode: pairMode !== 'qr',   // request 8-digit code
  showQr: pairMode !== 'code',         // print/emit QR
};
