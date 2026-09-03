/**
 * ════════════════════════════════════════════════════════════════
 *  Session / creds.json provisioning helpers
 *  - validates the session folder and creds.json structure
 *  - quarantines invalid creds so the bot can re-pair cleanly
 *  - reports a clear reason so console logs are never silent
 * ════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_KEYS = [
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'registrationId',
];

function ensureSessionDir(sessionFolder) {
  const dir = path.resolve(sessionFolder);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return { dir, created: true };
  }
  return { dir, created: false };
}

/**
 * Validate creds.json.
 * @returns {{ valid: boolean, reason: string, registered: boolean, path: string, exists: boolean }}
 */
function validateSession(credsFile) {
  const file = path.resolve(credsFile);
  if (!fs.existsSync(file)) {
    return { valid: false, exists: false, registered: false, path: file, reason: 'creds.json not found' };
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { valid: false, exists: true, registered: false, path: file, reason: `cannot read creds.json (${e.message})` };
  }

  if (!raw || !raw.trim()) {
    return { valid: false, exists: true, registered: false, path: file, reason: 'creds.json is empty' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { valid: false, exists: true, registered: false, path: file, reason: `creds.json is not valid JSON (${e.message})` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, exists: true, registered: false, path: file, reason: 'creds.json does not contain an object' };
  }

  const missing = REQUIRED_KEYS.filter((k) => parsed[k] === undefined || parsed[k] === null);
  if (missing.length) {
    return {
      valid: false, exists: true, registered: false, path: file,
      reason: `creds.json is missing required key(s): ${missing.join(', ')}`,
    };
  }

  // Only `registered: true` means WhatsApp accepted the link. A creds.json that
  // has `me` but not `registered` is a pairing that never completed — trying to
  // "restore" it makes WhatsApp answer 401 immediately.
  const registered = !!parsed.registered;
  if (!registered) {
    return {
      valid: false, exists: true, registered: false, path: file,
      reason: parsed.me ? 'pairing never completed (creds not registered)' : 'creds.json not registered yet',
    };
  }

  return {
    valid: true,
    exists: true,
    registered: true,
    path: file,
    reason: 'creds.json valid',
  };
}

/**
 * Move an invalid session aside so a fresh pairing can start.
 * @returns {string|null} quarantine folder path
 */
function quarantineSession(sessionFolder) {
  try {
    const dir = path.resolve(sessionFolder);
    if (!fs.existsSync(dir)) return null;
    const dest = `${dir}_invalid_${Date.now()}`;
    fs.renameSync(dir, dest);
    fs.mkdirSync(dir, { recursive: true });
    return dest;
  } catch {
    // Fallback: delete files individually
    try {
      const dir = path.resolve(sessionFolder);
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    } catch { /* ignore */ }
    return null;
  }
}

/**
 * Full provisioning check with clear logging.
 * @returns {{ hasValidCreds: boolean, needsPairing: boolean, info: object }}
 */
function provisionSession({ sessionFolder, credsFile, log = console.log }) {
  const { created } = ensureSessionDir(sessionFolder);
  if (created) log(`📁 Session folder created: ${path.resolve(sessionFolder)}`);

  let info = validateSession(credsFile);

  if (info.exists && !info.valid) {
    log(`⚠️ Invalid session detected — ${info.reason}`);
    const moved = quarantineSession(sessionFolder);
    log(moved ? `🧹 Invalid session quarantined at ${moved}` : '🧹 Invalid session files cleared');
    info = validateSession(credsFile);
  }

  if (info.valid) {
    log('🔐 Session valid — restoring WhatsApp connection from creds.json');
  } else {
    log(`🔓 No usable session (${info.reason}) — pairing required`);
  }

  return { hasValidCreds: info.valid, needsPairing: !info.valid, info };
}

module.exports = { ensureSessionDir, validateSession, quarantineSession, provisionSession, REQUIRED_KEYS };
