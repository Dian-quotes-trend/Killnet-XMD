/**
 * ════════════════════════════════════════════════════════════════════════════
 *                              W-MD BOT SERVER
 *                     WhatsApp Management Dashboard Bot
 *                              Version 2.3.0
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Merged: W-MD V2+ Lovable Cloud sync
 *  Uses contacts.upsert event for full contact/channel sync.
 *  Syncs directly to Lovable Cloud (no server URL needed).
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadContentFromMessage,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const config = require('./config');
const { provisionSession, validateSession, quarantineSession } = require('./lib/session');
let qrTerminal = null;
try { qrTerminal = require('qrcode-terminal'); } catch { /* optional */ }

// ─── Hardcoded Supabase/Cloud credentials (security: not in .env) ──
const SUPABASE_URL = 'https://xfxrobmibzxslfxujlof.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmeHJvYm1pYnp4c2xmeHVqbG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MTk4ODMsImV4cCI6MjA4NjM5NTg4M30.sKuvLTJPzYYsqH93vABVo33XGpSbwhmFmE7quB9R-ro';

// ─── Contact store (replaces makeInMemoryStore) ─────────────────
const contactStore = new Map(); // jid -> { name, type }
const groupMetadataCache = new Map();

// Baileys v7 supports both phone-number JIDs (@s.whatsapp.net) and
// Linked IDs (@lid). Never manufacture a PN JID from a LID.
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;
  const value = jid.trim();
  if (!value) return value;
  if (value.includes('@')) return jidNormalizedUser(value);
  return `${value.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

function messageRemoteJid(msg) {
  const key = msg?.key || {};
  // Prefer WhatsApp's alternate PN when the primary JID is a LID.
  if (key.remoteJid?.endsWith('@lid') && key.remoteJidAlt) return key.remoteJidAlt;
  if (key.remoteJid?.endsWith('@lid') && key.senderPn) return key.senderPn;
  return key.remoteJid;
}

function messageSenderJid(msg) {
  const key = msg?.key || {};
  if (key.participant?.endsWith('@lid') && key.participantPn) return key.participantPn;
  if (key.participant?.endsWith('@lid') && key.participantAlt) return key.participantAlt;
  if (key.remoteJid?.endsWith('@lid') && key.senderPn) return key.senderPn;
  return key.participant || key.remoteJid;
}

function getDisconnectCode(error) {
  if (!error) return undefined;
  if (error?.output?.statusCode) return error.output.statusCode;
  try { return new Boom(error).output?.statusCode; } catch { return undefined; }
}

// ─── Socket lifecycle state machine ─────────────────────────────
// STOPPED | STARTING | PAIRING | CONNECTED | RESTARTING | LOGGED_OUT | FAILED
const LIFECYCLE = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  PAIRING: 'PAIRING',
  CONNECTED: 'CONNECTED',
  RESTARTING: 'RESTARTING',
  LOGGED_OUT: 'LOGGED_OUT',
  FAILED: 'FAILED',
};

// Classify a WhatsApp disconnect instead of treating everything as a crash.
// Returns { kind, reconnect, delayMs, requiresPairing, invalidateSession, label }
function classifyDisconnect(code) {
  const R = (o) => ({ reconnect: false, delayMs: 0, requiresPairing: false, invalidateSession: false, ...o });
  switch (code) {
    case DisconnectReason.restartRequired: // 515 — normal post-pairing restart
      return R({ kind: 'restartRequired', label: 'Pairing complete — restarting socket', reconnect: true, delayMs: 1000 });
    case DisconnectReason.loggedOut: // 401
      return R({ kind: 'loggedOut', label: 'Logged out / device removed — re-pairing required', requiresPairing: true, invalidateSession: true });
    case DisconnectReason.badSession:
      return R({ kind: 'badSession', label: 'Corrupt session credentials — re-pairing required', requiresPairing: true, invalidateSession: true });
    case DisconnectReason.connectionReplaced: // 440
      // Usually caused by a second instance of this bot (or a stale socket).
      // We now tear old sockets down, so retry after a longer pause.
      return R({ kind: 'connectionReplaced', label: 'Session replaced by another login — make sure only ONE bot instance runs', reconnect: true, delayMs: 15000 });
    case DisconnectReason.connectionClosed:
      return R({ kind: 'connectionClosed', label: 'Connection closed', reconnect: true, delayMs: 3000 });
    case DisconnectReason.connectionLost:
      return R({ kind: 'connectionLost', label: 'Connection lost (network)', reconnect: true, delayMs: 5000 });
    case DisconnectReason.timedOut:
      return R({ kind: 'timedOut', label: 'Connection timed out', reconnect: true, delayMs: 5000 });
    case DisconnectReason.multideviceMismatch:
      return R({ kind: 'multideviceMismatch', label: 'Multi-device mismatch — re-pairing required', requiresPairing: true, invalidatePairing: true, invalidateSession: true });
    case DisconnectReason.forbidden: // 403
      return R({ kind: 'forbidden', label: 'Forbidden (403) — number may be blocked/banned by WhatsApp', requiresPairing: true, invalidateSession: true });
    case 405:
      // Typical when pairing with an unregistered session fails or WA version mismatch.
      return R({ kind: 'connectionFailure', label: 'Connection failure (405) — retrying with a fresh socket', reconnect: true, delayMs: 5000 });
    case DisconnectReason.unavailableService: // 503
      return R({ kind: 'unavailableService', label: 'WhatsApp service unavailable (503)', reconnect: true, delayMs: 15000 });
    default:
      return R({ kind: 'unknown', label: `Unknown disconnect (code: ${code ?? 'n/a'})`, reconnect: true, delayMs: 10000 });
  }
}




// ─── Global settings (Elite Pro style) ───────────────────────────
global.botName = config.botName;
global.ownerNumber = config.ownerNumber;
global.prefix = '.';
global.themeEmoji = '👨‍💻';
global.mess = {
  done: '✅ Task completed successfully!',
  prem: '⚠️ Access denied. Premium users only.',
  admin: '⚠️ Admin privileges required.',
  botAdmin: '⚠️ I need admin privileges in this chat.',
  owner: '⛔ Command restricted to the bot owner.',
  group: 'ℹ️ This command is for group chats only.',
  private: 'ℹ️ This command is for private chats only.',
  wait: '⏳ Processing... Please wait.',
  error: '❌ An error occurred. Please try again.',
};

// ─── Channel branding ────────────────────────────────────────────
const channelInfo = {
  contextInfo: {
    forwardingScore: 1,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: '120363420618370733@newsletter',
      newsletterName: 'W-MD BOTS',
      serverMessageId: -1,
    },
  },
};

// ─── State ───────────────────────────────────────────────────────
const state = {
  sock: null,
  connectionStatus: 'disconnected',
  qr: null,
  pairingCode: null,
  user: null,
  messageLogs: [],
  startTime: null,
  _pendingPhone: null,
  _pendingPairRequest: null,

  // Socket lifecycle (see LIFECYCLE / classifyDisconnect)
  lifecycle: LIFECYCLE.STOPPED,
  socketGen: 0,          // only handlers of the current generation may mutate state
  pairingInProgress: false,
  pairingPhone: null,
  lastDisconnectReason: null,
  requiresPairing: false,
  io: null,              // socket.io server (set by api.js) for live dashboard push


  settings: {
    prefix: '.',
    ownerNumber: config.ownerNumber,
    botName: config.botName,
    autoReply: { enabled: false, message: 'Hello! I am currently unavailable.' },
    autoRead: false,
    autoTyping: false,
    autoRecording: false,
    antiDelete: false,
    antiCall: { enabled: false, mode: 'decline', message: '🚫 Calls are not allowed. Please send a message instead.' },
    autoStatusView: false,
    autoReact: false,
    autoBio: false,
    autoBioText: '{bot} | Uptime: {uptime} | {msgs} msgs',
    autoLikeStatus: false,
    statusReactEmojis: ['👍', '❤️', '🔥', '😮', '💯'],
    autoReactEmojis: ['❤️', '🔥', '👍', '😂', '🎉'],
    goodbye: { enabled: false, message: 'Goodbye! 👋' },
    mode: 'public',
    presenceMode: 'online', // 'online' | 'last_seen'
  },
};

// ─── Lifecycle helpers / live dashboard websocket push ──────────
function emitWs(event, payload) {
  try { state.io?.emit(event, payload); } catch {}
}

function botSnapshot() {
  return {
    status: state.connectionStatus,
    lifecycle: state.lifecycle,
    qr: state.qr,
    pairingCode: state.pairingCode,
    pairingInProgress: state.pairingInProgress,
    requiresPairing: state.requiresPairing,
    lastDisconnectReason: state.lastDisconnectReason,
    user: state.user ? { id: state.user.id, name: state.user.name } : null,
    startTime: state.startTime,
    messageCount: state.messageLogs.length,
    botName: config.botName,
  };
}

function setLifecycle(next, extra = {}) {
  state.lifecycle = next;
  Object.assign(state, extra);
  console.log(`🔄 Lifecycle → ${next}`);
  emitWs('bot-status', botSnapshot());
}

// Guard every WhatsApp API operation: is this socket still the current, open one?
function isSocketLive(sock) {
  const target = sock || state.sock;
  if (!target) return false;
  if (target !== state.sock) return false; // stale generation
  if (state.connectionStatus !== 'connected') return false;
  if (target.ws?.isClosed || target.ws?.readyState === 3) return false;
  return true;
}

// Single pairing entry point — all sources (startup, REST, websocket,
// dashboard poller, message queue) must go through this so two pairing
// requests can never be in flight at once.
async function requestPairing(rawPhone, source = 'unknown') {
  const phone = String(rawPhone || '').replace(/[^0-9]/g, '');
  const fail = (error) => {
    console.error(`❌ Pair request (${source}) rejected: ${error}`);
    emitWs('pair-error', { error, phone, source });
    syncToCloud('pair_code_result', { code: null, error, phone }).catch(() => {});
    return { ok: false, error };
  };

  if (state.connectionStatus === 'connected') return fail('Bot already connected — log out first');
  if (state.pairingInProgress) {
    console.log(`⏳ Pair request (${source}) joined the in-flight attempt`);
    return { ok: true, pending: true, code: state.pairingCode };
  }
  if (!phone || phone.length < 10) return fail('Invalid phone number — include country code, digits only');
  if (!state.sock) return fail('Socket not ready — bot is still starting');
  if (state.sock.authState?.creds?.registered) return fail('Session already registered — restart the bot to re-pair');

  state.pairingInProgress = true;
  state.pairingPhone = phone;
  setLifecycle(LIFECYCLE.PAIRING);
  try {
    // A pairing code can only be requested over an OPEN WebSocket. Wait for it.
    if (typeof state.waitForSocketOpen === 'function') {
      const open = await state.waitForSocketOpen(20000);
      if (!open) console.log('⚠️ WebSocket still not open after 20s — trying pair request anyway');
    }
    if (!state.sock) return fail('Socket went away while waiting');
    const code = await state.sock.requestPairingCode(phone);
    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
    state.pairingCode = formatted;
    console.log(`\n🔗 PAIRING CODE (${source}): ${formatted}\n`);
    console.log('   WhatsApp → Linked devices → Link a device → Link with phone number instead');
    emitWs('pair-code', { code: formatted, phone, source });
    emitWs('bot-status', botSnapshot());
    await syncToCloud('pair_code_result', { code: formatted, phone }).catch(() => {});
    // Pair codes expire; after ~2 min drop it so the QR fallback is shown again.
    setTimeout(() => {
      if (state.pairingCode === formatted && state.connectionStatus !== 'connected') {
        console.log('⌛ Pairing code expired — QR fallback re-enabled. Request a new code if needed.');
        state.pairingCode = null;
        emitWs('bot-status', botSnapshot());
      }
    }, 120000);
    return { ok: true, code: formatted };
  } catch (err) {
    console.error('❌ requestPairingCode threw:', err?.stack || err?.message || err);
    addLog({ type: 'error', message: `Pairing error: ${err.message}` });
    return fail(err.message || 'Pairing failed');
  } finally {
    state.pairingInProgress = false;
  }
}


// Channel info attached only to outbound bot-command replies (so commands look like channel forwards).
// Dashboard-originated messages must NOT use this — they need to look like normal user messages.
const PLAIN_OUTBOUND = {}; // intentionally empty — used in place of channelInfo for dashboard sends

// ─── Data files ──────────────────────────────────────────────────
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2)); } catch {}
}

// Emoji list helpers — dashboard stores comma separated emojis.
function parseEmojiList(raw, fallback) {
  const list = String(raw || '').split(',').map((e) => e.trim()).filter(Boolean);
  return list.length ? list : fallback;
}
function pickEmoji(list) {
  const l = Array.isArray(list) && list.length ? list : ['👍'];
  return l[Math.floor(Math.random() * l.length)];
}

// Legacy config-file conventions (autoStatus.json / autoread.json / autotyping.json)
// mirrored from the single source of truth in state.settings.
function persistAutomationConfig() {
  saveJson('autoStatus.json', { enabled: state.settings.autoStatusView, reactOn: state.settings.autoLikeStatus, emojis: state.settings.statusReactEmojis });
  saveJson('autoread.json', { enabled: state.settings.autoRead });
  saveJson('autotyping.json', { enabled: state.settings.autoTyping, recording: state.settings.autoRecording });
  saveJson('antidelete.json', { enabled: state.settings.antiDelete });
  saveJson('anticall.json', { enabled: state.settings.antiCall.enabled, mode: state.settings.antiCall.mode, message: state.settings.antiCall.message });
  saveJson('autoreact.json', { enabled: state.settings.autoReact, emojis: state.settings.autoReactEmojis });
  // Mirror every toggle back to the dashboard so WhatsApp-side commands and the
  // web UI always show the same state.
  pushSettingsToCloud();
}

// Bidirectional settings sync — set while applying cloud settings so we don't
// immediately echo the same values back.
let suppressSettingsPush = false;
function settingsToCloudRow() {
  const s = state.settings;
  return {
    prefix: s.prefix,
    bot_name: s.botName,
    bot_mode: s.mode,
    presence_mode: s.presenceMode,
    auto_read_enabled: s.autoRead,
    auto_typing_enabled: s.autoTyping,
    auto_recording_enabled: s.autoRecording,
    auto_react_enabled: s.autoReact,
    auto_react_status_enabled: s.autoLikeStatus,
    auto_status_view: s.autoStatusView,
    auto_bio_enabled: s.autoBio,
    auto_bio_text: s.autoBioText,
    anti_delete_enabled: s.antiDelete,
    anti_call_enabled: s.antiCall?.enabled,
    anti_call_mode: s.antiCall?.mode,
    anti_call_message: s.antiCall?.message,
    auto_reply_enabled: s.autoReply?.enabled,
    auto_reply_message: s.autoReply?.message,
    status_react_emojis: Array.isArray(s.statusReactEmojis) ? s.statusReactEmojis.join(',') : s.statusReactEmojis,
    auto_react_emojis: Array.isArray(s.autoReactEmojis) ? s.autoReactEmojis.join(',') : s.autoReactEmojis,
  };
}
function pushSettingsToCloud() {
  if (suppressSettingsPush) return;
  syncToCloud('update_settings', { settings: settingsToCloudRow() }).catch(() => {});
}

// AFK system
let afkUsers = loadJson('afk.json', {});
function setAfk(jid, reason) { afkUsers[jid] = { reason, time: Date.now() }; saveJson('afk.json', afkUsers); }
function removeAfk(jid) { delete afkUsers[jid]; saveJson('afk.json', afkUsers); }

// Banned users
let bannedUsers = loadJson('banned.json', []);
function banUser(jid) { if (!bannedUsers.includes(jid)) { bannedUsers.push(jid); saveJson('banned.json', bannedUsers); } }
function unbanUser(jid) { bannedUsers = bannedUsers.filter(b => b !== jid); saveJson('banned.json', bannedUsers); }

// Warnings
let warnings = loadJson('warnings.json', {});
function warnUser(jid) { warnings[jid] = (warnings[jid] || 0) + 1; saveJson('warnings.json', warnings); return warnings[jid]; }

// Antilink groups
let antilinkGroups = loadJson('antilink.json', []);

// Continuous in-memory log buffer. We still trim only to keep the process
// from growing unbounded, but the threshold is high enough that the dashboard
// receives every message via realtime (no 500-cap visible to users).
const MAX_LOGS = 50000;
function addLog(entry) {
  const row = { ...entry, timestamp: new Date().toISOString() };
  state.messageLogs.unshift(row);
  if (state.messageLogs.length > MAX_LOGS) state.messageLogs.length = MAX_LOGS;
  emitWs('bot-log', row);
}


// ─── Lovable Cloud Sync ─────────────────────────────────────────
const SYNC_URL = `${SUPABASE_URL}/functions/v1/bot-sync`;
const SYNC_KEY = SUPABASE_KEY;
// Resolved by config.js: env var → .env file → HARDCODED fallback in config.js
const DASHBOARD_USER_ID = config.dashboardUserId || '';
if (!DASHBOARD_USER_ID) {
  console.warn('⚠️ DASHBOARD_USER_ID not set — cloud sync disabled. Set it in .env, your host panel, or config.js → HARDCODED.');
}
let syncQueue = [];
let lastSyncTime = 0;

async function syncToCloud(action, data) {
  if (!DASHBOARD_USER_ID || !SYNC_URL) return;
  try {
    const res = await axios.post(SYNC_URL, {
      action,
      userId: DASHBOARD_USER_ID,
      data,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SYNC_KEY}`,
        'apikey': SYNC_KEY,
      },
      timeout: 8000,
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

// Periodic status sync (every 30 seconds)
setInterval(async () => {
  if (state.connectionStatus !== 'disconnected') {
    await syncToCloud('status', {
      connectionStatus: state.connectionStatus,
      botPhone: state.user?.id?.split(':')[0] || null,
      messageCount: state.messageLogs.length,
      uptimeSeconds: Math.floor(process.uptime()),
      platform: getDeploymentPlatform(),
      botVersion: '2.3.0',
    });
  }
}, 30000);

// Sync logs in batches (every 10 seconds)
setInterval(async () => {
  if (syncQueue.length > 0) {
    const batch = syncQueue.splice(0, 20);
    try {
      await syncToCloud('logs_batch', { logs: batch });
    } catch (e) {
      syncQueue.unshift(...batch);
      console.log('⚠️ Log batch sync failed, will retry:', e.message);
    }
  }
}, 10000);

function queueLogSync(entry) {
  syncQueue.push(entry);
  syncToCloud('log', entry).catch(() => {});
}

// SEND-ONLY DASHBOARD: inbound WhatsApp messages are intentionally NOT synced to
// the cloud anymore (it overwhelmed the bot and the server). The dashboard only
// composes outbound messages; this stays as a no-op so callers remain harmless.
function syncChatMessage() { /* disabled — send-only dashboard */ }


// Inbound chat history + media retry queues removed with the send-only dashboard.
// These stubs keep any remaining call sites inert (no network, no timers).
function enqueueChatSync() { /* disabled */ }
async function flushChatSyncQueue() { /* disabled */ }
function schedulePendingMedia() { /* disabled */ }


// ─── Baileys message decoding helpers (per attached spec) ────────
const MEDIA_TYPE_MAP = {
  imageMessage:    { category: 'image',    stream: 'image'    },
  videoMessage:    { category: 'video',    stream: 'video'    },
  audioMessage:    { category: 'audio',    stream: 'audio'    },
  documentMessage: { category: 'document', stream: 'document' },
  documentWithCaptionMessage: { category: 'document', stream: 'document', wrap: true },
  stickerMessage:  { category: 'sticker',  stream: 'sticker'  },
  ptvMessage:      { category: 'video',    stream: 'video'    }, // round video note
};

// Unwrap viewOnce / ephemeral / documentWithCaption envelopes to their inner message
function unwrapMessage(message) {
  if (!message) return { inner: null, isViewOnce: false };
  let isViewOnce = false;
  let cur = message;
  // Peel layers
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.viewOnceMessage?.message) { cur = cur.viewOnceMessage.message; isViewOnce = true; continue; }
    if (cur.viewOnceMessageV2?.message) { cur = cur.viewOnceMessageV2.message; isViewOnce = true; continue; }
    if (cur.viewOnceMessageV2Extension?.message) { cur = cur.viewOnceMessageV2Extension.message; isViewOnce = true; continue; }
    if (cur.ephemeralMessage?.message) { cur = cur.ephemeralMessage.message; continue; }
    if (cur.documentWithCaptionMessage?.message) { cur = cur.documentWithCaptionMessage.message; continue; }
    if (cur.editedMessage?.message) { cur = cur.editedMessage.message; continue; }
    break;
  }
  return { inner: cur, isViewOnce };
}

function classifyMessage(inner) {
  if (!inner) return { type: 'unknown', category: 'unknown' };
  const type = Object.keys(inner)[0];
  if (MEDIA_TYPE_MAP[type]) return { type, category: MEDIA_TYPE_MAP[type].category };
  if (type === 'conversation' || type === 'extendedTextMessage') return { type, category: 'text' };
  if (type === 'locationMessage' || type === 'liveLocationMessage') return { type, category: 'location' };
  if (type === 'contactMessage' || type === 'contactsArrayMessage') return { type, category: 'contact' };
  if (type === 'reactionMessage') return { type, category: 'reaction' };
  if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return { type, category: 'system' };
  return { type, category: 'other' };
}

function extractText(inner) {
  if (!inner) return '';
  if (inner.conversation) return inner.conversation;
  if (inner.extendedTextMessage?.text) return inner.extendedTextMessage.text;
  if (inner.imageMessage?.caption) return inner.imageMessage.caption;
  if (inner.videoMessage?.caption) return inner.videoMessage.caption;
  if (inner.documentMessage?.caption) return inner.documentMessage.caption;
  if (inner.buttonsResponseMessage?.selectedDisplayText) return inner.buttonsResponseMessage.selectedDisplayText;
  if (inner.listResponseMessage?.title) return inner.listResponseMessage.title;
  return '';
}

// Convert a Baileys media stream into a Buffer
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Decrypt + upload a media message to Lovable Cloud with retry/backoff.
// Returns { url, mimeType, fileName, fileSize, status: 'ok'|'pending' }
async function downloadAndUploadMedia(inner, mediaType, maxAttempts = 3) {
  const meta = MEDIA_TYPE_MAP[mediaType];
  if (!meta) return null;
  const node = inner[mediaType];
  if (!node) return null;
  const mimeType = node.mimetype || 'application/octet-stream';
  const extGuess = (mimeType.split('/')[1] || 'bin').split(';')[0];
  const fileName = node.fileName || `${meta.category}-${Date.now()}.${extGuess}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = await downloadContentFromMessage(node, meta.stream);
      const buffer = await streamToBuffer(stream);
      if (!buffer.length) throw new Error('empty buffer');
      if (buffer.length > 50 * 1024 * 1024) {
        console.log(`⚠️  Media too large (${buffer.length} bytes), skipping upload`);
        return { url: null, mimeType, fileName, fileSize: buffer.length, status: 'too_large' };
      }
      const base64 = buffer.toString('base64');
      const res = await axios.post(SYNC_URL, {
        action: 'upload_media',
        userId: DASHBOARD_USER_ID,
        data: { base64, mimeType, fileName },
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYNC_KEY}`, 'apikey': SYNC_KEY },
        timeout: 45000,
        maxBodyLength: 80 * 1024 * 1024,
        maxContentLength: 80 * 1024 * 1024,
      });
      if (res.data?.url) {
        return { url: res.data.url, mimeType, fileName, fileSize: buffer.length, status: 'ok' };
      }
      throw new Error('no url returned');
    } catch (e) {
      lastErr = e;
      console.log(`⚠️  Media upload attempt ${attempt}/${maxAttempts} failed (${mediaType}): ${e.message}`);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }
  // All retries exhausted — flag as pending so cloud can retry later via re-sync.
  return { url: null, mimeType, fileName, fileSize: null, status: 'pending', error: lastErr?.message };
}

// Build the full chat_message payload from a Baileys msg
async function buildChatPayload(msg) {
  const jid = messageRemoteJid(msg);
  const isFromMe = !!msg.key.fromMe;
  const sender = messageSenderJid(msg);
  const pushName = msg.pushName || null;
  const { inner, isViewOnce } = unwrapMessage(msg.message);
  const { type, category } = classifyMessage(inner);
  const body = extractText(inner);

  const ctx = inner?.[type]?.contextInfo || inner?.extendedTextMessage?.contextInfo || null;
  const quoted = ctx?.quotedMessage || null;

  const payload = {
    chatJid: jid,
    chatName: jid.endsWith('@g.us') ? null : pushName,
    senderJid: sender,
    senderName: pushName,
    body: (body || '').substring(0, 4000),
    messageType: type,
    category,
    fromMe: isFromMe,
    waMessageId: msg.key.id,
    quotedMessageId: ctx?.stanzaId || null,
    isViewOnce,
    timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
    mediaStatus: 'ok',
  };

  // Quoted message preview (replies)
  if (quoted) {
    try {
      const { inner: qInner } = unwrapMessage(quoted);
      const { type: qType, category: qCategory } = classifyMessage(qInner);
      const qBody = extractText(qInner);
      payload.quotedBody = (qBody || '').substring(0, 300) || null;
      payload.quotedMessageType = qCategory || qType || null;
      payload.quotedSenderJid = ctx?.participant || null;
      // Best-effort sender name
      payload.quotedSenderName = null;
    } catch {}
  }

  // Media — DO NOT await here. Awaiting downloadAndUploadMedia inside the
  // messages.upsert for-loop can stall every subsequent message/status/log
  // sync if a single media item hangs (3×45s = 135s per message). Persist
  // metadata immediately and run the download in the background, then patch
  // the row via update_message_media_by_wa once the media is uploaded.
  if (inner && MEDIA_TYPE_MAP[type]) {
    const node = inner[type];
    payload.mimeType = node.mimetype || null;
    payload.fileName = node.fileName || null;
    payload.fileSize = Number(node.fileLength) || null;
    payload.durationSeconds = node.seconds || null;
    payload.width = node.width || null;
    payload.height = node.height || null;
    if (node.jpegThumbnail) {
      try { payload.thumbnailUrl = `data:image/jpeg;base64,${Buffer.from(node.jpegThumbnail).toString('base64')}`; } catch {}
    }
    payload.mediaStatus = 'pending';
    if (payload.waMessageId) {
      // Fire-and-forget background download; will patch the row when ready
      (async () => {
        try {
          const uploaded = await downloadAndUploadMedia(inner, type);
          if (uploaded?.url) {
            await syncToCloud('update_message_media_by_wa', {
              waMessageId: payload.waMessageId,
              mediaUrl: uploaded.url,
              mimeType: uploaded.mimeType,
              fileName: uploaded.fileName,
              fileSize: uploaded.fileSize,
              status: 'ok',
            });
          } else {
            schedulePendingMedia(payload.waMessageId, inner, type);
          }
        } catch {
          schedulePendingMedia(payload.waMessageId, inner, type);
        }
      })();
    }
  }

  // Location
  if (type === 'locationMessage') {
    payload.latitude = inner.locationMessage.degreesLatitude;
    payload.longitude = inner.locationMessage.degreesLongitude;
    payload.body = inner.locationMessage.name || inner.locationMessage.address || '📍 Location';
  }
  if (type === 'liveLocationMessage') {
    payload.latitude = inner.liveLocationMessage.degreesLatitude;
    payload.longitude = inner.liveLocationMessage.degreesLongitude;
    payload.body = '📍 Live location';
  }

  // Contact
  if (type === 'contactMessage') {
    payload.vcard = inner.contactMessage.vcard || null;
    payload.body = inner.contactMessage.displayName || '👤 Contact';
  }
  if (type === 'contactsArrayMessage') {
    payload.body = `👤 ${inner.contactsArrayMessage.contacts?.length || 0} contacts`;
  }

  return payload;
}


// Track last-known pair flag so we only act on transitions to true
let lastPairFlag = false;
let lastBackfillRequestedAt = null;

// Fetch settings from cloud — returns full row so caller can react to flags
async function fetchCloudSettings() {
  if (!DASHBOARD_USER_ID) return null;
  try {
    const res = await axios.post(SYNC_URL, {
      action: 'get_settings',
      userId: DASHBOARD_USER_ID,
      data: {},
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SYNC_KEY}`,
        'apikey': SYNC_KEY,
      },
      timeout: 5000,
    });
    if (res.data?.settings) {
      const s = res.data.settings;
      // Applying cloud values must not echo straight back to the cloud.
      suppressSettingsPush = true;
      if (s.prefix) state.settings.prefix = s.prefix;
      if (s.owner_number) state.settings.ownerNumber = s.owner_number;
      if (s.bot_name) state.settings.botName = s.bot_name;
      if (s.auto_read_enabled !== undefined) state.settings.autoRead = s.auto_read_enabled;
      if (s.anti_delete_enabled !== undefined) state.settings.antiDelete = s.anti_delete_enabled;
      if (s.anti_call_enabled !== undefined) state.settings.antiCall.enabled = s.anti_call_enabled;
      if (s.anti_call_mode) state.settings.antiCall.mode = s.anti_call_mode;
      if (s.anti_call_message) state.settings.antiCall.message = s.anti_call_message;
      if (s.status_react_emojis) state.settings.statusReactEmojis = parseEmojiList(s.status_react_emojis, state.settings.statusReactEmojis);
      if (s.auto_react_emojis) state.settings.autoReactEmojis = parseEmojiList(s.auto_react_emojis, state.settings.autoReactEmojis);
      if (s.auto_bio_text) state.settings.autoBioText = s.auto_bio_text;
      if (s.auto_status_view !== undefined) state.settings.autoStatusView = s.auto_status_view;
      if (s.auto_reply_enabled !== undefined) state.settings.autoReply.enabled = s.auto_reply_enabled;
      if (s.auto_reply_message) state.settings.autoReply.message = s.auto_reply_message;
      if (s.goodbye_enabled !== undefined) state.settings.goodbye.enabled = s.goodbye_enabled;
      if (s.goodbye_message) state.settings.goodbye.message = s.goodbye_message;
      // ── New automation toggles (SU1/SU2) ────────────────────────
      if (s.auto_typing_enabled !== undefined) state.settings.autoTyping = s.auto_typing_enabled;
      if (s.auto_recording_enabled !== undefined) state.settings.autoRecording = s.auto_recording_enabled;
      if (s.auto_react_enabled !== undefined) state.settings.autoReact = s.auto_react_enabled;
      if (s.auto_react_status_enabled !== undefined) state.settings.autoLikeStatus = s.auto_react_status_enabled;
      if (s.auto_bio_enabled !== undefined) state.settings.autoBio = s.auto_bio_enabled;
      if (s.bot_mode) state.settings.mode = s.bot_mode;
      if (s.presence_mode) state.settings.presenceMode = s.presence_mode;
      // Keep the legacy on-disk config files in sync so script-side commands and
      // the dashboard always read the same values.
      persistAutomationConfig();
      suppressSettingsPush = false;
      // Apply presence immediately if connected
      if (state.sock && state.connectionStatus === 'connected') {
        try {
          state.sock.sendPresenceUpdate(state.settings.presenceMode === 'online' ? 'available' : 'unavailable');
        } catch {}
      }
      return s;
    }
  } catch (e) {
    suppressSettingsPush = false;
    console.log('⚠️  Could not fetch cloud settings:', e.message);
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function getDeploymentPlatform() {
  if (process.env.RENDER) return 'Render';
  if (process.env.CODESPACE_NAME) return 'Codespaces';
  if (process.env.PANEL_APP || process.env.P_SERVER_UUID) return 'Bot-Host Panel';
  return 'Local Machine';
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function credsExist() {
  return validateSession(config.credsFile).valid;
}

// Move an unusable session aside so the next start pairs cleanly.
function invalidateSession(reason = 'unknown') {
  const moved = quarantineSession(config.sessionFolder);
  console.log(moved
    ? `🧹 Session invalidated (${reason}) — quarantined at ${moved}`
    : `🧹 Session invalidated (${reason}) — session files cleared`);
  state.requiresPairing = true;
  state.pairingCode = null;
  state.qr = null;
  return moved;
}

async function checkIfAdmin(sock, groupJid, userJid) {
  try {
    let meta = groupMetadataCache.get(groupJid);
    if (!meta) {
      meta = await sock.groupMetadata(groupJid);
      groupMetadataCache.set(groupJid, meta);
    }
    return meta.participants.some(p => p.id === userJid && (p.admin === 'admin' || p.admin === 'superadmin'));
  } catch { return false; }
}

// ─── Command Registry ────────────────────────────────────────────
const commands = new Map();

function registerCommand(name, category, description, handler, ownerOnly = false) {
  commands.set(name, { category, description, handler, ownerOnly });
}

// ════════════════════════════════════════════════════════════════
// COMMANDS — MAIN
// ════════════════════════════════════════════════════════════════

registerCommand('ping', 'Main', 'Check bot speed', async (sock, msg) => {
  const start = Date.now();
  await sock.sendMessage(msg.key.remoteJid, { text: '📡 Pinging...', ...channelInfo }, { quoted: msg });
  const latency = Date.now() - start;
  await sock.sendMessage(msg.key.remoteJid, {
    text: `🏓 *Pong!*\n\n⚡ Speed: ${latency}ms\n🤖 Bot: ${state.settings.botName}\n⏱ Uptime: ${formatUptime(process.uptime())}\n🗃 RAM: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n💻 Platform: ${getDeploymentPlatform()}`,
    ...channelInfo,
  });
});

registerCommand('alive', 'Main', 'Check bot status', async (sock, msg) => {
  await sock.sendMessage(msg.key.remoteJid, {
    text: `*${global.themeEmoji} ${state.settings.botName} is Active!*\n\n✅ Status: Online\n⏱ Uptime: ${formatUptime(process.uptime())}\n🌐 Prefix: ${state.settings.prefix}\n📨 Messages: ${state.messageLogs.length}\n💻 Platform: ${getDeploymentPlatform()}\n\nType *${state.settings.prefix}menu* for commands`,
    ...channelInfo,
  }, { quoted: msg });
});

registerCommand('menu', 'Main', 'Show all commands', async (sock, msg) => {
  const p = state.settings.prefix;
  const categories = {};
  for (const [name, cmd] of commands) {
    if (!categories[cmd.category]) categories[cmd.category] = [];
    categories[cmd.category].push(`│ ${p}${name} - ${cmd.description}${cmd.ownerOnly ? ' 👑' : ''}`);
  }
  let menu = `╔══════════════════════════╗\n║  ${global.themeEmoji} *${state.settings.botName}* ${global.themeEmoji}  ║\n╚══════════════════════════╝\n\n⏱ Uptime: ${formatUptime(process.uptime())}\n📨 Messages: ${state.messageLogs.length}\n🌐 Mode: ${state.settings.mode}\n\n`;
  for (const [cat, cmds] of Object.entries(categories)) {
    menu += `╔══ *${cat}* ══\n${cmds.join('\n')}\n╚══════════════════════════╝\n\n`;
  }
  menu += `_Powered by W-MD Dashboard_`;
  await sock.sendMessage(msg.key.remoteJid, { text: menu, ...channelInfo }, { quoted: msg });
});

registerCommand('help', 'Main', 'Help guide', async (sock, msg) => {
  await commands.get('menu').handler(sock, msg);
});

registerCommand('owner', 'Main', 'Show bot owner', async (sock, msg) => {
  await sock.sendMessage(msg.key.remoteJid, {
    text: `👑 *Bot Owner*\n\n• Contact: ${state.settings.ownerNumber || 'Not set'}\n🤖 Bot: ${state.settings.botName}`,
    ...channelInfo,
  }, { quoted: msg });
});

registerCommand('info', 'Main', 'Bot information', async (sock, msg) => {
  const mem = process.memoryUsage();
  await sock.sendMessage(msg.key.remoteJid, {
    text: `*📊 ${state.settings.botName} Info*\n\n• Prefix: ${state.settings.prefix}\n• Uptime: ${formatUptime(process.uptime())}\n• Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB\n• Node: ${process.version}\n• Mode: ${state.settings.mode}\n• Platform: ${getDeploymentPlatform()}\n• Version: 2.3.0\n• Cloud Sync: ${DASHBOARD_USER_ID ? '✅' : '❌'}`,
    ...channelInfo,
  }, { quoted: msg });
});

// ════════════════════════════════════════════════════════════════
// COMMANDS — SETTINGS (owner only)
// ════════════════════════════════════════════════════════════════

registerCommand('settings', 'Settings', 'View current settings', async (sock, msg) => {
  const s = state.settings;
  await sock.sendMessage(msg.key.remoteJid, {
    text: `*⚙️ Settings*\n\n• Mode: ${s.mode}\n• Prefix: ${s.prefix}\n• Presence: ${s.presenceMode}\n• Auto Read: ${s.autoRead ? '✅' : '❌'}\n• Auto Typing: ${s.autoTyping ? '✅' : '❌'}\n• Auto Recording: ${s.autoRecording ? '✅' : '❌'}\n• Anti Delete: ${s.antiDelete ? '✅' : '❌'}\n• Anti Call: ${s.antiCall.enabled ? '✅' : '❌'} (${s.antiCall.mode})\n• Auto Status: ${s.autoStatusView ? '✅' : '❌'}\n• Auto React Status: ${s.autoLikeStatus ? '✅' : '❌'}\n• Auto React: ${s.autoReact ? '✅' : '❌'}\n• Auto Bio: ${s.autoBio ? '✅' : '❌'}\n• Auto Reply: ${s.autoReply.enabled ? '✅' : '❌'}`,
    ...channelInfo,
  }, { quoted: msg });
}, true);

registerCommand('mode', 'Settings', 'Toggle public/private', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  if (action === 'public' || action === 'private') {
    state.settings.mode = action;
    pushSettingsToCloud();
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ Bot is now in *${action}* mode`, ...channelInfo }, { quoted: msg });
  } else {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: *${state.settings.mode}*\nUsage: .mode public/private`, ...channelInfo }, { quoted: msg });
  }
}, true);

registerCommand('autoread', 'Settings', 'Toggle auto read', async (sock, msg) => {
  state.settings.autoRead = !state.settings.autoRead;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Read: ${state.settings.autoRead ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autotyping', 'Settings', 'Toggle auto typing', async (sock, msg) => {
  state.settings.autoTyping = !state.settings.autoTyping;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Typing: ${state.settings.autoTyping ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autorecording', 'Settings', 'Toggle auto recording', async (sock, msg) => {
  state.settings.autoRecording = !state.settings.autoRecording;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Recording: ${state.settings.autoRecording ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('antidelete', 'Settings', 'Toggle anti delete', async (sock, msg) => {
  state.settings.antiDelete = !state.settings.antiDelete;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Anti Delete: ${state.settings.antiDelete ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('anticall', 'Settings', 'Toggle anti call', async (sock, msg) => {
  state.settings.antiCall.enabled = !state.settings.antiCall.enabled;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Anti Call: ${state.settings.antiCall.enabled ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autostatus', 'Settings', 'Toggle auto status view', async (sock, msg) => {
  state.settings.autoStatusView = !state.settings.autoStatusView;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Status View: ${state.settings.autoStatusView ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autoreact', 'Settings', 'Toggle auto react', async (sock, msg) => {
  state.settings.autoReact = !state.settings.autoReact;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto React: ${state.settings.autoReact ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autobio', 'Settings', 'Toggle auto bio update', async (sock, msg) => {
  state.settings.autoBio = !state.settings.autoBio;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Bio: ${state.settings.autoBio ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('autoreply', 'Settings', 'Toggle auto reply / set text', async (sock, msg, args) => {
  if (args.length > 0) {
    state.settings.autoReply.message = args.join(' ');
    state.settings.autoReply.enabled = true;
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Reply set to: "${state.settings.autoReply.message}"`, ...channelInfo }, { quoted: msg });
  } else {
    state.settings.autoReply.enabled = !state.settings.autoReply.enabled;
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Reply: ${state.settings.autoReply.enabled ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
  }
  pushSettingsToCloud();
}, true);

registerCommand('autoreactstatus', 'Settings', 'Toggle auto react to statuses', async (sock, msg) => {
  state.settings.autoLikeStatus = !state.settings.autoLikeStatus;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto React Status: ${state.settings.autoLikeStatus ? 'ON' : 'OFF'}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('presence', 'Settings', 'Set presence: online/lastseen/typing/recording/off', async (sock, msg, args) => {
  const modes = ['online', 'lastseen', 'typing', 'recording', 'off'];
  const mode = (args[0] || '').toLowerCase();
  if (!modes.includes(mode)) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: *${state.settings.presenceMode}*\nUsage: ${state.settings.prefix}presence ${modes.join('/')}`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.presenceMode = mode;
  const map = { online: 'available', lastseen: 'unavailable', typing: 'composing', recording: 'recording', off: 'unavailable' };
  try { await sock.sendPresenceUpdate(map[mode]); } catch {}
  pushSettingsToCloud();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Presence: *${mode}*`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('setprefix', 'Settings', 'Change command prefix', async (sock, msg, args) => {
  const p = (args[0] || '').trim();
  if (!p || p.length > 2) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current prefix: *${state.settings.prefix}*\nUsage: ${state.settings.prefix}setprefix .`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.prefix = p;
  pushSettingsToCloud();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Prefix is now *${p}*`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('setbio', 'Settings', 'Set auto-bio template', async (sock, msg, args) => {
  if (!args.length) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current bio template:\n${state.settings.autoBioText}\n\nUsage: ${state.settings.prefix}setbio W-MD online • {time}`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.autoBioText = args.join(' ');
  pushSettingsToCloud();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto Bio template updated`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('anticallmode', 'Settings', 'Set anti-call mode: decline/ignore', async (sock, msg, args) => {
  const mode = (args[0] || '').toLowerCase();
  if (!['decline', 'ignore'].includes(mode)) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: *${state.settings.antiCall.mode}*\nUsage: ${state.settings.prefix}anticallmode decline/ignore`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.antiCall.mode = mode;
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Anti Call mode: *${mode}*`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('anticallmsg', 'Settings', 'Set anti-call auto reply text', async (sock, msg, args) => {
  if (!args.length) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: ${state.settings.antiCall.message || '(none)'}\nUsage: ${state.settings.prefix}anticallmsg Sorry, calls are blocked.`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.antiCall.message = args.join(' ');
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Anti Call message updated`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('statusreact', 'Settings', 'Set status react emojis (comma separated)', async (sock, msg, args) => {
  if (!args.length) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: ${(state.settings.statusReactEmojis || []).join(',')}\nUsage: ${state.settings.prefix}statusreact 💚,🔥,😎`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.statusReactEmojis = args.join(' ').split(',').map((e) => e.trim()).filter(Boolean);
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Status react emojis: ${state.settings.statusReactEmojis.join(' ')}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('reactemoji', 'Settings', 'Set auto-react emojis (comma separated)', async (sock, msg, args) => {
  if (!args.length) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Current: ${(state.settings.autoReactEmojis || []).join(',')}\nUsage: ${state.settings.prefix}reactemoji 👍,❤️,😂`, ...channelInfo }, { quoted: msg });
    return;
  }
  state.settings.autoReactEmojis = args.join(' ').split(',').map((e) => e.trim()).filter(Boolean);
  persistAutomationConfig();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Auto react emojis: ${state.settings.autoReactEmojis.join(' ')}`, ...channelInfo }, { quoted: msg });
}, true);


// ════════════════════════════════════════════════════════════════
// COMMANDS — GROUP MANAGEMENT
// ════════════════════════════════════════════════════════════════

registerCommand('tagall', 'Group', 'Tag all members', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  try {
    const meta = await sock.groupMetadata(jid);
    let text = '📢 *Tagging all:*\n\n';
    const mentions = [];
    for (const p of meta.participants) { text += `@${p.id.split('@')[0]}\n`; mentions.push(p.id); }
    await sock.sendMessage(jid, { text, mentions, ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.botAdmin, ...channelInfo }); }
});

registerCommand('hidetag', 'Group', 'Hidden tag all', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  const text = args.join(' ') || '📢 Attention!';
  try {
    const meta = await sock.groupMetadata(jid);
    const mentions = meta.participants.map(p => p.id);
    await sock.sendMessage(jid, { text, mentions, ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.botAdmin, ...channelInfo }); }
});

registerCommand('kick', 'Group', 'Remove member', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned?.length) return sock.sendMessage(jid, { text: '❌ Tag someone to kick', ...channelInfo });
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'remove');
    await sock.sendMessage(jid, { text: `${global.mess.done} Removed ${mentioned.length} member(s)`, ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.botAdmin, ...channelInfo }); }
});

registerCommand('promote', 'Group', 'Promote to admin', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned?.length) return sock.sendMessage(jid, { text: '❌ Tag someone', ...channelInfo });
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'promote');
    await sock.sendMessage(jid, { text: `${global.mess.done} Promoted ${mentioned.length} member(s)`, ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.error, ...channelInfo }); }
});

registerCommand('demote', 'Group', 'Demote from admin', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned?.length) return sock.sendMessage(jid, { text: '❌ Tag someone', ...channelInfo });
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'demote');
    await sock.sendMessage(jid, { text: `${global.mess.done} Demoted ${mentioned.length} member(s)`, ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.error, ...channelInfo }); }
});

registerCommand('groupinfo', 'Group', 'Get group info', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  try {
    const meta = await sock.groupMetadata(jid);
    const admins = meta.participants.filter(p => p.admin).length;
    await sock.sendMessage(jid, {
      text: `📋 *Group Info*\n\n📛 Name: ${meta.subject}\n👥 Members: ${meta.participants.length}\n👑 Admins: ${admins}\n📝 Desc: ${meta.desc || 'None'}\n🔒 Restrict: ${meta.restrict ? 'Yes' : 'No'}\n📅 Created: ${new Date(meta.creation * 1000).toLocaleDateString()}`,
      ...channelInfo,
    }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.error, ...channelInfo }); }
});

registerCommand('mute', 'Group', 'Mute group', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  try {
    await sock.groupSettingUpdate(jid, 'announcement');
    await sock.sendMessage(jid, { text: '🔇 Group muted. Only admins can send messages.', ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.botAdmin, ...channelInfo }); }
}, true);

registerCommand('unmute', 'Group', 'Unmute group', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  try {
    await sock.groupSettingUpdate(jid, 'not_announcement');
    await sock.sendMessage(jid, { text: '🔊 Group unmuted. Everyone can send messages.', ...channelInfo }, { quoted: msg });
  } catch { await sock.sendMessage(jid, { text: global.mess.botAdmin, ...channelInfo }); }
}, true);

registerCommand('antilink', 'Group', 'Toggle anti-link in group', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: global.mess.group, ...channelInfo });
  if (antilinkGroups.includes(jid)) {
    antilinkGroups = antilinkGroups.filter(g => g !== jid);
    saveJson('antilink.json', antilinkGroups);
    await sock.sendMessage(jid, { text: '✅ Anti-link disabled for this group', ...channelInfo }, { quoted: msg });
  } else {
    antilinkGroups.push(jid);
    saveJson('antilink.json', antilinkGroups);
    await sock.sendMessage(jid, { text: '✅ Anti-link enabled for this group', ...channelInfo }, { quoted: msg });
  }
}, true);

// ════════════════════════════════════════════════════════════════
// COMMANDS — MODERATION
// ════════════════════════════════════════════════════════════════

registerCommand('ban', 'Moderation', 'Ban a user', async (sock, msg, args) => {
  const jid = args[0] ? `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || '');
  if (!jid) return sock.sendMessage(msg.key.remoteJid, { text: 'Usage: .ban @user or .ban number', ...channelInfo });
  banUser(jid);
  await sock.sendMessage(msg.key.remoteJid, { text: `🚫 Banned: ${jid.split('@')[0]}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('unban', 'Moderation', 'Unban a user', async (sock, msg, args) => {
  const jid = args[0] ? `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || '');
  if (!jid) return sock.sendMessage(msg.key.remoteJid, { text: 'Usage: .unban @user or .unban number', ...channelInfo });
  unbanUser(jid);
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Unbanned: ${jid.split('@')[0]}`, ...channelInfo }, { quoted: msg });
}, true);

registerCommand('warn', 'Moderation', 'Warn a user', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mentioned) return sock.sendMessage(msg.key.remoteJid, { text: '❌ Tag someone to warn', ...channelInfo });
  const count = warnUser(mentioned);
  await sock.sendMessage(msg.key.remoteJid, { text: `⚠️ Warning #${count} for @${mentioned.split('@')[0]}`, mentions: [mentioned], ...channelInfo }, { quoted: msg });
}, true);

// ════════════════════════════════════════════════════════════════
// COMMANDS — UTILITY
// ════════════════════════════════════════════════════════════════

registerCommand('afk', 'Utility', 'Set AFK status', async (sock, msg, args) => {
  const sender = msg.key.participant || msg.key.remoteJid;
  const reason = args.join(' ') || 'No reason';
  setAfk(sender, reason);
  await sock.sendMessage(msg.key.remoteJid, { text: `💤 @${sender.split('@')[0]} is now AFK\nReason: ${reason}`, mentions: [sender], ...channelInfo }, { quoted: msg });
});

registerCommand('sticker', 'Utility', 'Create sticker from image/video', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const isImg = msg.message?.imageMessage || quoted?.imageMessage;
  const isVid = msg.message?.videoMessage || quoted?.videoMessage;
  if (!isImg && !isVid) return sock.sendMessage(msg.key.remoteJid, { text: '📎 Reply to an image or video', ...channelInfo });
  try {
    const source = quoted || msg.message;
    const sourceType = source?.imageMessage ? 'imageMessage' : 'videoMessage';
    const mediaNode = source?.[sourceType];
    if (!mediaNode) throw new Error('Unsupported media type');
    const stream = await downloadContentFromMessage(
      mediaNode,
      sourceType === 'imageMessage' ? 'image' : 'video'
    );
    const media = await streamToBuffer(stream);
    // Baileys expects sticker media to be WebP. Image/video conversion is
    // intentionally left to the deployment's media toolchain; do not pass
    // arbitrary MP4/JPEG bytes as a sticker and expect WhatsApp to convert it.
    if (sourceType !== 'imageMessage') {
      throw new Error('Video-to-sticker conversion requires a WebP/FFmpeg conversion step');
    }
    await sock.sendMessage(msg.key.remoteJid, { sticker: media }, { quoted: msg });
  } catch (e) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Sticker failed: ${e.message}`, ...channelInfo });
  }
});

registerCommand('toimg', 'Utility', 'Convert sticker to image', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.stickerMessage) return sock.sendMessage(msg.key.remoteJid, { text: '📎 Reply to a sticker', ...channelInfo });
  try {
    const mediaNode = quoted.stickerMessage;
    const stream = await downloadContentFromMessage(mediaNode, 'sticker');
    const media = await streamToBuffer(stream);
    await sock.sendMessage(msg.key.remoteJid, { image: media }, { quoted: msg });
  } catch (e) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed: ${e.message}`, ...channelInfo });
  }
});

registerCommand('delete', 'Utility', 'Delete a message', async (sock, msg) => {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.stanzaId) return sock.sendMessage(msg.key.remoteJid, { text: '📎 Reply to a message to delete', ...channelInfo });
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      delete: { remoteJid: msg.key.remoteJid, fromMe: ctx.participant === sock.user?.id, id: ctx.stanzaId, participant: ctx.participant },
    });
  } catch { await sock.sendMessage(msg.key.remoteJid, { text: global.mess.error, ...channelInfo }); }
});

registerCommand('del', 'Utility', 'Delete shortcut', async (sock, msg, args) => {
  await commands.get('delete').handler(sock, msg, args);
});

registerCommand('report', 'Utility', 'Report to bot owner', async (sock, msg, args) => {
  const report = args.join(' ');
  if (!report) return sock.sendMessage(msg.key.remoteJid, { text: 'Usage: .report <message>', ...channelInfo });
  if (state.settings.ownerNumber) {
    const sender = msg.key.participant || msg.key.remoteJid;
    try {
      await sock.sendMessage(normalizeJid(state.settings.ownerNumber), {
        text: `📢 *Report from @${sender.split('@')[0]}*\n\n${report}`,
        mentions: [sender],
        ...channelInfo,
      });
      await sock.sendMessage(msg.key.remoteJid, { text: '✅ Report sent to bot owner!', ...channelInfo }, { quoted: msg });
    } catch { await sock.sendMessage(msg.key.remoteJid, { text: global.mess.error, ...channelInfo }); }
  } else {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Owner number not configured', ...channelInfo });
  }
});

registerCommand('broadcast', 'Utility', 'Broadcast to all chats', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) return sock.sendMessage(msg.key.remoteJid, { text: 'Usage: .broadcast <message>', ...channelInfo });
  await sock.sendMessage(msg.key.remoteJid, { text: `📡 Broadcast sent:\n"${text}"`, ...channelInfo }, { quoted: msg });
}, true);

// ─── Track contacts from messages ────────────────────────────────
const knownContacts = new Map(); // jid -> { name, type }

function trackContact(jid, name) {
  if (!jid || jid === 'status@broadcast') return;
  if (jid.endsWith('@s.whatsapp.net') && !jid.startsWith('status')) {
    knownContacts.set(jid, { name: name || jid.split('@')[0], type: 'contact' });
  }
}

// ─── Sync contacts, groups & channels to cloud ──────────────────
let _contactSyncInFlight = false;
let _lastContactSyncAt = 0;
let _contactSyncTimer = null;

function scheduleContactSync(sock, reason = 'event', delayMs = 8000) {
  // Debounce: collapse many rapid contacts.upsert events into a single sync
  if (_contactSyncTimer) clearTimeout(_contactSyncTimer);
  _contactSyncTimer = setTimeout(() => {
    _contactSyncTimer = null;
    syncContactsToCloud(sock, reason).catch(() => {});
  }, delayMs);
}

async function syncContactsToCloud(sock, reason = 'manual') {
  if (!DASHBOARD_USER_ID) return;
  if (!isSocketLive(sock)) {
    console.log(`⏭️  Contact sync skipped (socket not live) — reason: ${reason}`);
    return;
  }
  if (_contactSyncInFlight) {
    console.log(`⏭️  Contact sync skipped (already running) — reason: ${reason}`);
    return;
  }
  // Throttle: at most once every 20s unless explicitly forced
  const since = Date.now() - _lastContactSyncAt;
  if (reason !== 'force' && since < 20000) {
    console.log(`⏭️  Contact sync throttled (${Math.round(since/1000)}s since last) — reason: ${reason}`);
    return;
  }
  _contactSyncInFlight = true;
  try {
    const contactsList = [];
    const seenJids = new Set();

    // 1. Groups via Baileys API (with subjects)
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        groupMetadataCache.set(jid, meta);
        if (seenJids.has(jid)) continue;
        seenJids.add(jid);
        contactsList.push({
          jid,
          name: meta.subject || `Group ${jid.split('@')[0].slice(-6)}`,
          type: 'group',
          participantsCount: meta.participants?.length || 0,
        });
        // Also collect participants with the best name available
        for (const p of meta.participants || []) {
          if (!p.id || !p.id.endsWith('@s.whatsapp.net') || seenJids.has(p.id)) continue;
          seenJids.add(p.id);
          // Prefer contactStore (push name from contacts.upsert) > participant notify > digits
          const stored = contactStore.get(p.id);
          const name = stored?.name || p.notify || p.name || p.id.split('@')[0];
          knownContacts.set(p.id, { name, type: 'contact' });
          contactsList.push({ jid: p.id, name, type: 'contact', participantsCount: 0 });
        }
      }
      console.log(`📋 Fetched ${Object.keys(groups).length} groups`);
    } catch (e) {
      console.log('⚠️ Could not fetch groups:', e.message);
    }

    // 2. contacts.upsert store (proper names from WhatsApp itself)
    for (const [jid, info] of contactStore) {
      if (seenJids.has(jid)) continue;
      seenJids.add(jid);
      const cleanName = info.name && info.name !== jid.split('@')[0] ? info.name : null;
      if (jid.endsWith('@s.whatsapp.net') && !jid.startsWith('status')) {
        contactsList.push({ jid, name: cleanName || jid.split('@')[0], type: 'contact', participantsCount: 0 });
      } else if (jid.endsWith('@newsletter')) {
        contactsList.push({ jid, name: info.name || `Channel ${jid.split('@')[0].slice(-6)}`, type: 'channel', participantsCount: 0 });
      }
    }

    // 3. Fallback: contacts seen in messages
    for (const [jid, info] of knownContacts) {
      if (seenJids.has(jid)) continue;
      seenJids.add(jid);
      contactsList.push({ jid, name: info.name, type: 'contact', participantsCount: 0 });
    }

    if (contactsList.length === 0) {
      console.log('⚠️ No contacts to sync (contactStore empty, groups empty)');
      return;
    }

    // ── Single atomic batch: clear + bulk insert in ONE call ──
    // The edge function handles "clear then insert" inside one request,
    // so the dashboard never sees a half-empty list.
    const result = await syncToCloud('sync_contacts', {
      contacts: contactsList,
      clearFirst: true,
      reason,
      startedBy: 'bot',
    });
    console.log(`☁️  Synced ${contactsList.length} contacts/groups/channels in one batch (reason=${reason})`);
    return result;
  } catch (e) {
    console.log('⚠️ Contact sync failed:', e.message);
  } finally {
    _lastContactSyncAt = Date.now();
    _contactSyncInFlight = false;
  }
}

// ─── Scheduled contact import worker (20 contacts every 15 min) ──
let _importWorkerRunning = false;
async function processImportQueue(sock) {
  if (!DASHBOARD_USER_ID || !isSocketLive(sock)) return;
  if (_importWorkerRunning) {
    console.log('⏭️  Import worker already running — skipping tick');
    return;
  }
  _importWorkerRunning = true;
  try {
    const res = await axios.post(SYNC_URL, {
      action: 'get_pending_imports', userId: DASHBOARD_USER_ID, data: {},
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYNC_KEY}`, 'apikey': SYNC_KEY },
      timeout: 8000,
    });
    const imports = res.data?.imports || [];
    if (imports.length === 0) return;
    console.log(`📥 Processing ${imports.length} pending contact imports...`);

    for (const imp of imports) {
      try {
        const phone = (imp.phone || '').replace(/[^0-9]/g, '');
        if (!phone) {
          await syncToCloud('complete_import', { importId: imp.id, exists: false });
          continue;
        }
        // Validate via Baileys
        let result;
        try {
          result = await sock.onWhatsApp(phone);
        } catch (e) {
          // Transient: network/socket issue → ask cloud to retry with backoff
          await syncToCloud('complete_import', {
            importId: imp.id, transientError: (e && e.message) || 'lookup failed',
          });
          continue;
        }
        const found = Array.isArray(result) ? result.find((r) => r.exists) : null;
        if (found) {
          // Deterministic name: prefer queue display_name, then contactStore, then digits
          const stored = contactStore.get(found.jid);
          const name = imp.display_name || stored?.name || phone;
          await syncToCloud('complete_import', {
            importId: imp.id, exists: true, jid: found.jid, name,
          });
        } else {
          await syncToCloud('complete_import', { importId: imp.id, exists: false });
        }
      } catch (e) {
        console.log(`⚠️ Import check failed for ${imp.phone}: ${e.message}`);
        // Transient: ask cloud to retry with backoff
        await syncToCloud('complete_import', {
          importId: imp.id, transientError: e.message || 'unknown',
        });
      }
      // Spread requests so we don't get rate-limited
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    // silent
  } finally {
    _importWorkerRunning = false;
  }
}

// ─── Start bot ───────────────────────────────────────────────────
let _startingBot = false;
async function startBot() {
  // Never let two startBot() calls overlap — overlapping sockets fight each
  // other and WhatsApp answers with 440 (connectionReplaced) forever.
  if (_startingBot) { console.log('⏳ startBot already in progress — skipping duplicate call'); return; }
  _startingBot = true;
  try {
    return await _startBotInner();
  } finally {
    _startingBot = false;
  }
}

async function _startBotInner() {
  // Tear down any previous socket so only ONE WhatsApp connection exists.
  if (state.sock) {
    const old = state.sock;
    state.sock = null;
    try { old.ev.removeAllListeners('connection.update'); } catch {}
    try { old.ev.removeAllListeners('creds.update'); } catch {}
    try { old.ws?.close?.(); } catch {}
    try { old.end?.(undefined); } catch {}
  }

  // GF2: Clear stale dashboard requests at startup so a previous offline-pair
  // request can't crash a freshly-restored session.
  await syncToCloud('clear_stale_requests', {}).catch(() => {});

  // Fetch settings from cloud first (best effort — never block on cloud)
  await fetchCloudSettings().catch(() => {});

  const sessionDir = path.resolve(config.sessionFolder);
  const provision = provisionSession({
    sessionFolder: config.sessionFolder,
    credsFile: config.credsFile,
  });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Fetching the WA Web version can fail on hosts with flaky DNS/HTTP — fall
  // back to Baileys' bundled default instead of crashing the start.
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    console.log(`⚠️ Could not fetch latest WA version (${e.message}) — using Baileys default`);
    version = undefined;
  }

  // 'silent' hid every Baileys error, which is why failures looked like "nothing
  // happens". Default to 'error'; set BAILEYS_LOG_LEVEL=debug for deep tracing.
  const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });
  const hasExistingCreds = provision.hasValidCreds;

  const usePairingCode = !hasExistingCreds && config.usePairingCode;
  const pairModeLabel = { code: 'Pairing Code (8-digit)', qr: 'QR Code', both: 'Pairing Code + QR fallback' }[config.pairMode];

  console.log('─────────────────────────────────────────');
  console.log(`  ${config.botName} v2.3 (Baileys 7.0.0-rc14)`);
  console.log(`  WA version: ${version ? version.join('.') : 'default'}`);
  console.log(`  Existing session: ${hasExistingCreds ? 'YES ✓' : 'NO'}`);
  console.log(`  Auth mode: ${hasExistingCreds ? 'Auto (creds.json)' : pairModeLabel} [PAIR_MODE=${config.pairMode}]`);
  console.log(`  Dashboard ID: ${DASHBOARD_USER_ID || 'NOT SET'}`);
  console.log(`  Cloud sync: ${DASHBOARD_USER_ID ? 'Enabled ✅' : 'Not configured'}`);
  console.log('─────────────────────────────────────────');

  state.connectionStatus = 'connecting';
  state.qr = null;
  state.pairingCode = null;
  state.pairingInProgress = false;
  const myGen = ++state.socketGen;
  const isCurrent = () => state.socketGen === myGen;
  setLifecycle(LIFECYCLE.STARTING);

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 20000,
    // v7 recommends caching group metadata to avoid repeated metadata queries
    // and reduce group-send failures/rate limiting.
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
  });

  state.sock = sock;

  // ── CRITICAL: persist creds on EVERY update, registered before any await.
  // Previously this was attached after the pairing prompt, so early key
  // updates were dropped and the session never became "registered".
  sock.ev.on('creds.update', saveCreds);

  // Resolves once the underlying WebSocket is open (needed before a pairing
  // code can be requested). Falls back after a timeout so callers never hang.
  const waitForSocketOpen = (timeoutMs = 20000) => new Promise((resolve) => {
    if (sock.ws?.isOpen) return resolve(true);
    const started = Date.now();
    const t = setInterval(() => {
      if (!isCurrent()) { clearInterval(t); return resolve(false); }
      if (sock.ws?.isOpen || state.qr) { clearInterval(t); return resolve(true); }
      if (Date.now() - started > timeoutMs) { clearInterval(t); return resolve(false); }
    }, 250);
  });
  state.waitForSocketOpen = waitForSocketOpen;

  // ── Baileys v7 history sync — seeds contacts/chats in one batch ──
  sock.ev.on('messaging-history.set', ({ contacts = [], chats = [], isLatest }) => {
    try {
      let added = 0;
      for (const c of contacts) {
        if (!c?.id) continue;
        const name = c.name || c.notify || c.verifiedName || c.id.split('@')[0];
        contactStore.set(c.id, {
          name,
          type: c.id.endsWith('@newsletter') ? 'channel' : c.id.endsWith('@g.us') ? 'group' : 'contact',
        });
        added++;
      }
      for (const ch of chats) {
        if (!ch?.id || contactStore.has(ch.id)) continue;
        contactStore.set(ch.id, {
          name: ch.name || ch.id.split('@')[0],
          type: ch.id.endsWith('@newsletter') ? 'channel' : ch.id.endsWith('@g.us') ? 'group' : 'contact',
        });
        added++;
      }
      console.log(`📚 History sync: +${added} entries (contacts=${contacts.length}, chats=${chats.length}, latest=${!!isLatest})`);
    } catch (e) {
      console.log('⚠️ history sync error:', e.message);
    }
  });



  // ── Listen for contacts.upsert event (replaces makeInMemoryStore) ──
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.id) {
        contactStore.set(contact.id, {
          name: contact.name || contact.notify || contact.id.split('@')[0],
          type: contact.id.endsWith('@newsletter') ? 'channel' : 
                contact.id.endsWith('@g.us') ? 'group' : 'contact',
        });
      }
    }
    console.log(`📇 contacts.upsert: ${contacts.length} contacts received (total: ${contactStore.size})`);
    // Debounced batch sync — WhatsApp often fires upsert in many bursts after connect
    scheduleContactSync(sock, 'contacts.upsert', 8000);
  });

  // Also listen for contacts.update
  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (update.id) {
        const existing = contactStore.get(update.id) || { name: update.id.split('@')[0], type: 'contact' };
        if (update.notify) existing.name = update.notify;
        if (update.name) existing.name = update.name;
        contactStore.set(update.id, existing);
      }
    }
    scheduleContactSync(sock, 'contacts.update', 10000);
  });

  // Keep the group cache warm for Baileys' cachedGroupMetadata hook.
  sock.ev.on('groups.upsert', (groups) => {
    for (const group of groups || []) if (group?.id) groupMetadataCache.set(group.id, group);
  });
  sock.ev.on('groups.update', (updates) => {
    for (const update of updates || []) {
      if (!update?.id) continue;
      const previous = groupMetadataCache.get(update.id) || {};
      groupMetadataCache.set(update.id, { ...previous, ...update });
    }
  });

  // Pairing code flow — always via the single requestPairing() entrypoint.
  // Runs in the background AFTER all listeners are attached so a TTY prompt or
  // the pre-pair delay can never block connection.update / creds.update.
  if (usePairingCode && !hasExistingCreds && !sock.authState.creds.registered) {
    state.requiresPairing = true;
    (async () => {
      let phoneNumber;
      if (state._pendingPhone) {
        phoneNumber = state._pendingPhone;
        state._pendingPhone = null;
      } else if (config.ownerNumber && config.ownerNumber.length > 5) {
        phoneNumber = config.ownerNumber;
      } else if (process.stdin.isTTY) {
        phoneNumber = await askQuestion('\n📱 Enter WhatsApp number (with country code, no + or spaces):\n> ');
      } else {
        console.log('📟 No TTY and no OWNER_NUMBER set — waiting for a pair request from the dashboard.');
        console.log('   Open the dashboard → Settings → Pair Device, enter your number, and a code will appear here.');
        phoneNumber = '';
      }
      phoneNumber = (phoneNumber || '').replace(/[^0-9]/g, '');
      if (!phoneNumber || phoneNumber.length < 10) {
        if (phoneNumber) console.log(`❌ Invalid phone number "${phoneNumber}" — needs country code, digits only.`);
        console.log(`⏳ Pairing idle — request a pair code from the dashboard${config.showQr ? ' (QR fallback is also active)' : ' (QR disabled: PAIR_MODE=code)'}.`);
        return;
      }
      const open = await waitForSocketOpen();
      if (!isCurrent()) return;
      if (!open) console.log('⚠️ WebSocket not open yet — attempting pair request anyway');
      await requestPairing(phoneNumber, 'startup');
    })().catch((e) => console.error('⚠️ startup pairing error:', e.message));
  }

  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      if (!isCurrent()) return; // stale socket generation — ignore
      const { connection, lastDisconnect, qr: qrCode } = update;

      if (qrCode) {
        if (!config.showQr) {
          // PAIR_MODE=code → 8-digit code only; QR is never surfaced.
          if (!state._qrHiddenNotice) {
            state._qrHiddenNotice = true;
            console.log('📟 QR hidden (PAIR_MODE=code). Set PAIR_MODE=qr or both to enable QR scanning.');
          }
        } else if (state.pairingInProgress || state.pairingCode) {
          // Suppress QR while a pairing-code attempt is live (code-first flow).
          console.log('📟 QR suppressed — pairing code flow in progress');
        } else {
          state.qr = qrCode;
          // Push QR to dashboard so user can scan from the web UI when creds.json is missing
          syncToCloud('qr_update', { qr: qrCode }).catch(() => {});
          emitWs('qr', { qr: qrCode });
          if (qrTerminal) { try { qrTerminal.generate(qrCode, { small: true }); } catch {} }
          console.log('📱 QR generated — scan it above, or scan from the dashboard Pair screen');
        }
      }

      if (connection === 'connecting') {
        console.log('🔌 Connecting to WhatsApp...');
      }

      if (connection === 'close') {
        state.connectionStatus = 'disconnected';
        state.qr = null;
        state.pairingCode = null;
        state.user = null;
        state.pairingInProgress = false;
        const reason = getDisconnectCode(lastDisconnect?.error);
        const info = classifyDisconnect(reason);
        state.lastDisconnectReason = { code: reason, kind: info.kind, label: info.label };
        state.requiresPairing = info.requiresPairing;
        console.log(`⚠️ ${info.label} (code: ${reason ?? 'n/a'})`);
        if (lastDisconnect?.error?.message) console.log(`   ↳ ${lastDisconnect.error.message}`);
        if (lastDisconnect?.error?.data) { try { console.log('   ↳ data:', JSON.stringify(lastDisconnect.error.data)); } catch {} }
        addLog({ type: 'system', message: `Disconnected: ${info.label}` });

        if (info.invalidateSession) {
          try { invalidateSession(info.kind); } catch {}
        }

        setLifecycle(info.reconnect ? LIFECYCLE.RESTARTING : (info.requiresPairing ? LIFECYCLE.LOGGED_OUT : LIFECYCLE.STOPPED));

        syncToCloud('status', { connectionStatus: 'disconnected', botPhone: null, messageCount: state.messageLogs.length, uptimeSeconds: Math.floor(process.uptime()), platform: getDeploymentPlatform() }).catch(() => {});
        syncToCloud('qr_update', { qr: null }).catch(() => {});
        syncToCloud('activity', { action: 'bot_disconnected', details: `${info.kind}: ${info.label}` }).catch(() => {});

        if (info.reconnect) {
          console.log(`↻ Reconnecting in ${info.delayMs / 1000}s...`);
          setTimeout(() => safeStartBot(`disconnect:${info.kind}`), info.delayMs);
        } else if (info.requiresPairing) {
          // Restart the socket so a fresh pairing attempt (code or QR) is possible.
          console.log('🔑 Re-pairing required — restarting socket in 5s to await a new pair request');
          setTimeout(() => safeStartBot(`repair:${info.kind}`), 5000);
        } else {
          console.log('🛑 Not reconnecting automatically for this reason.');
        }
      }

      if (connection === 'open') {
        state.connectionStatus = 'connected';
        state.qr = null;
        state.pairingCode = null;
        state.pairingInProgress = false;
        state.requiresPairing = false;
        state.lastDisconnectReason = null;
        state.user = sock.user;
        state.startTime = new Date().toISOString();
        setLifecycle(LIFECYCLE.CONNECTED);
        const phone = sock.user?.id?.split(':')[0] || 'unknown';
        console.log(`\n✅ Connected as ${sock.user?.name || phone}`);
        addLog({ type: 'system', message: `Connected as ${sock.user?.name || phone}` });


        syncToCloud('status', {
          connectionStatus: 'connected',
          botPhone: phone,
          messageCount: state.messageLogs.length,
          uptimeSeconds: Math.floor(process.uptime()),
          platform: getDeploymentPlatform(),
        }).catch(() => {});
        // Clear stale QR/pair on dashboard
        syncToCloud('qr_update', { qr: null }).catch(() => {});
        syncToCloud('pair_code_result', { code: null, phone: null }).catch(() => {});
        syncToCloud('activity', { action: 'bot_connected', details: `Phone: ${phone}, Platform: ${getDeploymentPlatform()}` }).catch(() => {});

        // GF2: Clear any stale dashboard requests (pair, sync, queued specials)
        // so a residual flag from a previous offline session can't crash this one.
        syncToCloud('clear_stale_requests', {}).catch(() => {});

        // SU2: Apply presence mode
        try {
          await sock.sendPresenceUpdate(state.settings.presenceMode === 'online' ? 'available' : 'unavailable');
        } catch {}

        // Wait 30s post-connect so WhatsApp finishes pushing contacts.upsert before we sync
        scheduleContactSync(sock, 'post-connect', 30000);

        try {
          const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(botJid, {
            text: `╔══════════════════════════╗\n║   🤖 W-MD ACTIVATED!     ║\n╠══════════════════════════╣\n║  ✅ Status: ONLINE\n║  🌐 Prefix: ${state.settings.prefix}\n║  💻 Platform: ${getDeploymentPlatform()}\n║  ☁️  Cloud: ${DASHBOARD_USER_ID ? 'Synced' : 'N/A'}\n╚══════════════════════════╝\n\n_W-MD WhatsApp Bot v2.3_`,
            ...channelInfo,
          });
        } catch {}
      }
    } catch (e) {
      console.error('⚠️ connection.update handler error:', e.message);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Anti-call: log + auto-reject ──
  sock.ev.on('call', async (calls) => {
    try {
      for (const call of calls || []) {
        const callerJid = call.from;
        if (!callerJid) continue;
        // Send-only dashboard: calls are handled locally, not synced to the cloud.

        if (state.settings.antiCall.enabled && call.status === 'offer') {
          if (state.settings.antiCall.mode === 'decline') {
            try { await sock.rejectCall(call.id, callerJid); } catch {}
          }
          if (state.settings.antiCall.message) {
            try { await sock.sendMessage(callerJid, { text: state.settings.antiCall.message, ...channelInfo }); } catch {}
          }
        }
      }
    } catch (e) { console.log('⚠️ call handler error:', e.message); }
  });

  // ── Outbound delivery / read receipts → ticks in dashboard ──
  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const u of updates || []) {
        const id = u.key?.id;
        if (!id) continue;
        const s = Number(u.update?.status);
        // WAMessageStatus: SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
        if (s === 4 || s === 5) {
          syncToCloud('mark_message_status', { waMessageId: id, status: 'read' }).catch(() => {});
        } else if (s === 3) {
          syncToCloud('mark_message_status', { waMessageId: id, status: 'delivered' }).catch(() => {});
        } else if (s === 2) {
          syncToCloud('mark_message_status', { waMessageId: id, status: 'sent' }).catch(() => {});
        }
      }
    } catch (e) { console.log('⚠️ messages.update handler error:', e.message); }
  });


  // ── Message handler ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;
      const sender = msg.key.participant || msg.key.remoteJid;
      const pushName = msg.pushName || 'Unknown';

      // Build a fully-classified payload (handles viewOnce, ephemeral, all media types)
      let chatPayload;
      try { chatPayload = await buildChatPayload(msg); }
      catch (e) { console.log('⚠️ buildChatPayload failed:', e.message); chatPayload = null; }

      const body = chatPayload?.body || '';
      const messageType = chatPayload?.messageType || 'unknown';
      const category = chatPayload?.category || 'other';

      // Status broadcasts: auto-view / auto-react locally only (never synced)
      if (jid === 'status@broadcast') {
        if (state.settings.autoStatusView) {
          try { await sock.readMessages([msg.key]); } catch {}
          if (state.settings.autoLikeStatus) {
            try { await sock.sendMessage(jid, { react: { text: pickEmoji(state.settings.statusReactEmojis), key: msg.key } }); } catch {}
          }
        }
        continue;
      }

      // Send-only dashboard: inbound messages are NOT persisted to the cloud.


      // Skip non-command fromMe messages
      if (isFromMe && !body.startsWith(state.settings.prefix)) continue;

      // Skip if banned
      if (bannedUsers.includes(sender)) continue;

      // Skip if private mode and not owner
      if (state.settings.mode === 'private' && !isFromMe && sender !== normalizeJid(state.settings.ownerNumber)) continue;

      // Log the message, track contact, and persist into cloud chat history
      if (!isFromMe) {
        trackContact(sender, pushName);
        trackContact(jid, null);
        addLog({ type: 'message', from: jid, pushName, text: body || `[${category}]`, messageType });
        queueLogSync({
          logType: 'message',
          sender: sender,
          pushName: pushName,
          chatJid: jid,
          body: (body || `[${category}]`).substring(0, 500),
          messageType: messageType,
        });
      }

      // Auto read
      if (state.settings.autoRead && !isFromMe) {
        try { await sock.readMessages([msg.key]); } catch {}
      }

      // Auto typing indicator
      if (state.settings.autoTyping && !isFromMe) {
        try { await sock.sendPresenceUpdate('composing', jid); } catch {}
      }

      // Auto recording indicator
      if (state.settings.autoRecording && !isFromMe) {
        try { await sock.sendPresenceUpdate('recording', jid); } catch {}
      }

      // Anti-link check in groups
      if (!isFromMe && antilinkGroups.includes(jid) && body && /https?:\/\//.test(body)) {
        const isAdmin = await checkIfAdmin(sock, jid, sender);
        if (!isAdmin) {
          try {
            await sock.sendMessage(jid, { text: '🚫 Links are not allowed!', mentions: [sender], ...channelInfo }, { quoted: msg });
            await sock.sendMessage(jid, { delete: msg.key });
          } catch {}
          continue;
        }
      }

      // AFK check
      if (!isFromMe && msg.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
        for (const mentioned of msg.message.extendedTextMessage.contextInfo.mentionedJid) {
          if (afkUsers[mentioned]) {
            const afk = afkUsers[mentioned];
            const elapsed = Math.floor((Date.now() - afk.time) / 60000);
            await sock.sendMessage(jid, { text: `💤 @${mentioned.split('@')[0]} is AFK (${elapsed}m ago)\nReason: ${afk.reason}`, mentions: [mentioned], ...channelInfo });
          }
        }
      }

      // AFK return detection
      if (!isFromMe && afkUsers[sender]) {
        const afk = afkUsers[sender];
        const elapsed = Math.floor((Date.now() - afk.time) / 60000);
        removeAfk(sender);
        await sock.sendMessage(jid, { text: `👋 @${sender.split('@')[0]} is back from AFK (was away ${elapsed}m)`, mentions: [sender], ...channelInfo });
      }

      // Auto react
      if (state.settings.autoReact && body && !isFromMe) {
        try { await sock.sendMessage(jid, { react: { text: pickEmoji(state.settings.autoReactEmojis), key: msg.key } }); } catch {}
      }

      // Command handling
      if (body.startsWith(state.settings.prefix)) {
        const parts = body.slice(state.settings.prefix.length).trim().split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const args = parts.slice(1);

        const cmd = commands.get(cmdName);
        if (cmd) {
          if (cmd.ownerOnly && !isFromMe && sender !== normalizeJid(state.settings.ownerNumber)) {
            await sock.sendMessage(jid, { text: global.mess.owner, ...channelInfo }, { quoted: msg });
            continue;
          }

          queueLogSync({
            logType: 'command',
            sender: sender,
            pushName: pushName,
            chatJid: jid,
            body: `${state.settings.prefix}${cmdName} ${args.join(' ')}`.trim(),
            messageType: 'command',
          });

          try { await cmd.handler(sock, msg, args); } catch (err) {
            console.error(`Command error [${cmdName}]:`, err.message);
            await sock.sendMessage(jid, { text: global.mess.error, ...channelInfo }, { quoted: msg }).catch(() => {});
          }
        }
        continue;
      }

      // Auto reply (private chats only)
      if (!isFromMe && state.settings.autoReply.enabled && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast')) {
        try { await sock.sendMessage(jid, { text: state.settings.autoReply.message, ...channelInfo }); } catch {}
      }
    }
  });

  // Anti-delete — v7 exposes revocations through messages.delete.
  sock.ev.on('messages.delete', async ({ keys } = {}) => {
    if (!state.settings.antiDelete) return;
    for (const key of keys || []) {
      const chatJid = key?.remoteJid;
      const log = state.messageLogs.find((l) => l.from === chatJid && l.type === 'message');
      if (!log) continue;

      addLog({
        type: 'system',
        message: `🔴 Anti-Delete: ${log.pushName || 'Unknown'} deleted: "${log.text || ''}"`,
      });

      if (state.settings.ownerNumber) {
        try {
          await sock.sendMessage(normalizeJid(state.settings.ownerNumber), {
            text: `🔴 *Anti-Delete*\n\nFrom: ${log.pushName || 'Unknown'}\nChat: ${chatJid}\nMessage: "${log.text || ''}"`,
            ...channelInfo,
          });
        } catch {}
      }
    }
  });

  // Goodbye
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'remove' && state.settings.goodbye.enabled) {
      for (const p of participants) {
        try {
          const text = state.settings.goodbye.message.replace('{user}', `@${p.split('@')[0]}`);
          await sock.sendMessage(id, { text, mentions: [p], ...channelInfo });
        } catch {}
      }
    }
  });

  // Auto-bio updater interval
  setInterval(async () => {
    if (state.connectionStatus === 'connected' && state.settings.autoBio) {
      try {
        await sock.updateProfileStatus(
          (state.settings.autoBioText || '{bot} | Uptime: {uptime} | {msgs} msgs')
            .replace('{bot}', state.settings.botName)
            .replace('{uptime}', formatUptime(process.uptime()))
            .replace('{msgs}', String(state.messageLogs.length))
        );
      } catch {}
    }
  }, 5 * 60 * 1000);

  // ── Dashboard Message Queue Polling (every 5 seconds) ──
  setInterval(async () => {
    if (!DASHBOARD_USER_ID) return;
    const offline = state.connectionStatus !== 'connected';
    try {
      const res = await axios.post(SYNC_URL, {
        action: 'get_pending_messages',
        userId: DASHBOARD_USER_ID,
        data: {},
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYNC_KEY}`, 'apikey': SYNC_KEY },
        timeout: 8000,
      });

      const messages = res.data?.messages || [];
      for (const m of messages) {
        // While offline only pairing/restart controls are processed — everything
        // else stays queued until the socket is connected again.
        if (offline && m.recipient_jid !== '__request_pair_code__' && m.recipient_jid !== '__restart_bot__') continue;

        // Special sync command
        if (m.recipient_jid === '__sync_contacts__') {
          console.log('📋 Dashboard requested contact sync...');
          await syncContactsToCloud(sock, 'force');
          await markMessage(m.id, 'mark_message_sent');
          continue;
        }

        // Special pair code request from dashboard
        if (m.recipient_jid === '__request_pair_code__') {
          console.log('🔗 Dashboard requested pair code for:', m.message_text);
          const phone = String(m.message_text || '').replace(/[^0-9]/g, '');
          const result = await requestPairing(phone, 'message-queue');
          await markMessage(m.id, result.ok ? 'mark_message_sent' : 'mark_message_failed');
          continue;
        }

        // Special restart command from dashboard
        if (m.recipient_jid === '__restart_bot__') {
          console.log('🔄 Dashboard requested restart...');
          await markMessage(m.id, 'mark_message_sent');
          await syncToCloud('activity', { action: 'bot_restarting', details: 'Restart requested from dashboard' });
          // Close socket and restart
          try { sock.end(); } catch {}
          setTimeout(() => {
            console.log('🔄 Restarting bot...');
            safeStartBot('dashboard-restart');
          }, 2000);
          return; // Exit this interval
        }

        // Special logout command from dashboard
        if (m.recipient_jid === '__logout_bot__') {
          console.log('🚪 Dashboard requested logout...');
          await markMessage(m.id, 'mark_message_sent');
          await syncToCloud('status', { connectionStatus: 'disconnected', botPhone: null, messageCount: 0, uptimeSeconds: 0, platform: getDeploymentPlatform() });
          await syncToCloud('activity', { action: 'bot_logged_out', details: 'Logout requested from dashboard' });
          // Delete session files
          try {
            const sessionFiles = fs.readdirSync(sessionDir);
            for (const file of sessionFiles) {
              fs.unlinkSync(path.join(sessionDir, file));
            }
            console.log('🗑️ Session files deleted');
          } catch (e) {
            console.log('⚠️ Could not delete session files:', e.message);
          }
          // Close socket (will trigger reconnect which will show pairing flow)
          try { await sock.logout(); } catch {}
          try { sock.end(); } catch {}
          setTimeout(() => safeStartBot('dashboard-logout'), 3000);
          return;
        }

        // Special clear-chat command from dashboard (MF1) — channels are excluded server-side already
        if (m.recipient_jid === '__clear_chat__') {
          console.log('🧹 Dashboard requested chat clear:', m.message_text);
          // Server-side handler in edge function does the deletion; nothing to do on bot.
          await markMessage(m.id, 'mark_message_sent');
          continue;
        }

        // Send actual message (text or media)
        // MF3: do NOT add channelInfo — dashboard messages must look like normal user messages,
        // not forwarded channel posts.
        try {
          const msgType = m.message_type || 'text';
          const mediaUrl = m.media_url;
          const recipientJid = normalizeJid(m.recipient_jid);
          if (!recipientJid || recipientJid.startsWith('@')) throw new Error('Invalid recipient JID');
          if (!isSocketLive(sock)) throw new Error('Socket not connected — message stays queued');
          let sentMsg = null;

          if (msgType !== 'text' && mediaUrl) {
            // MF2: download media (cap at 50MB to match dashboard upload limit)
            const mediaResponse = await axios.get(mediaUrl, {
              responseType: 'arraybuffer',
              timeout: 60000,
              maxContentLength: 50 * 1024 * 1024,
              maxBodyLength: 50 * 1024 * 1024,
            });
            const buffer = Buffer.from(mediaResponse.data);
            const caption = m.message_text || '';
            const mimeFromUrl = (mediaUrl.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] || '';

            if (msgType === 'image') {
              sentMsg = await sock.sendMessage(recipientJid, { image: buffer, caption });
            } else if (msgType === 'video') {
              sentMsg = await sock.sendMessage(recipientJid, { video: buffer, caption });
            } else if (msgType === 'audio') {
              sentMsg = await sock.sendMessage(recipientJid, {
                audio: buffer,
                mimetype: mimeFromUrl === 'ogg' ? 'audio/ogg; codecs=opus' : 'audio/mpeg',
                ptt: m.message_text === '__ptt__',
              });
            } else if (msgType === 'sticker') {
              sentMsg = await sock.sendMessage(recipientJid, { sticker: buffer });
            } else {
              const fileName = m.message_text || `file.${mimeFromUrl || 'bin'}`;
              sentMsg = await sock.sendMessage(recipientJid, {
                document: buffer,
                fileName,
                mimetype: 'application/octet-stream',
              });
            }
          } else {
            // Plain text — no channelInfo so it looks like a regular message
            sentMsg = await sock.sendMessage(recipientJid, { text: m.message_text });
          }

          await markMessage(m.id, 'mark_message_sent');
          // Send-only dashboard: no chat-history persistence, just the sent counter.

          // SU2: Bump sent counter
          syncToCloud('increment_message_counter', { direction: 'sent', count: 1 }).catch(() => {});
          emitWs('message-sent', { to: recipientJid, type: msgType, queueId: m.id, at: new Date().toISOString() });
          console.log(`📤 Dashboard message sent to ${recipientJid} (${msgType})`);
        } catch (err) {
          console.error(`❌ Failed to send dashboard message:`, err.message);
          emitWs('message-error', { to: m.recipient_jid, queueId: m.id, error: err.message });
          await markMessage(m.id, 'mark_message_failed');
        }
      }
    } catch (e) {
      // Silent fail
    }
  }, 5000);

  // Helper to mark messages
  async function markMessage(id, action) {
    try {
      await axios.post(SYNC_URL, {
        action,
        userId: DASHBOARD_USER_ID,
        data: { messageId: id },
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYNC_KEY}`, 'apikey': SYNC_KEY },
        timeout: 5000,
      });
    } catch {}
  }
}

// ─── API Server (for local testing / optional) ───────────────────
const { startAPI } = require('./api');

// ─── Crash-resistant startup wrapper with auto-restart ──────────
let restartAttempts = 0;
let restartTimer = null;
async function safeStartBot(reason = 'initial') {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  try {
    console.log(`🚀 safeStartBot (${reason}) — attempt #${restartAttempts + 1}`);
    await startBot();
    restartAttempts = 0;
  } catch (e) {
    restartAttempts++;
    const delay = Math.min(60000, 3000 * Math.pow(2, Math.min(restartAttempts, 5)));
    console.error(`❌ Bot startup failed (${e.message}). Retrying in ${delay / 1000}s...`);
    syncToCloud('activity', { action: 'bot_crash', details: e.message }).catch(() => {});
    restartTimer = setTimeout(() => safeStartBot('crash-recovery'), delay);
  }
}

// Catch any unhandled error so the process never dies silently
process.on('uncaughtException', (e) => {
  console.error('💥 uncaughtException:', e.message);
  syncToCloud('activity', { action: 'uncaught_exception', details: e.message }).catch(() => {});
});
process.on('unhandledRejection', (e) => {
  console.error('💥 unhandledRejection:', (e && e.message) || e);
});

// ─── Dashboard control flag poller (pair_requested, backfill) ──
//   Polls cloud every 7s for transitions on the pair_requested flag,
//   triggering pair-code-first then QR fallback automatically.
setInterval(async () => {
  if (!DASHBOARD_USER_ID) return;
  const s = await fetchCloudSettings();
  if (!s) return;

  // Pair flag transition: false -> true
  if (s.pair_requested && !lastPairFlag) {
    lastPairFlag = true;
    console.log('🔗 Dashboard set pair_requested=true');
    const phone = (s.pair_phone || s.owner_number || '').replace(/[^0-9]/g, '');
    // Pair code first via the single entrypoint; QR (already pushed from
    // connection.update) is the automatic fallback when this fails.
    await requestPairing(phone, 'dashboard-flag');
  }
  if (!s.pair_requested) lastPairFlag = false;

  // Backfill request: dashboard sets backfill_requested_at
  if (s.backfill_requested_at && s.backfill_requested_at !== lastBackfillRequestedAt) {
    lastBackfillRequestedAt = s.backfill_requested_at;
    // Best-effort: re-sync contacts so chat list is fresh; full historic message
    // backfill from Baileys is limited — we resync recent state.
    if (state.sock && state.connectionStatus === 'connected') {
      console.log('🔄 Dashboard requested backfill — resyncing contacts/groups');
      syncContactsToCloud(state.sock, 'force').catch(() => {});
    }
  }
}, 7000);

// ─── Scheduled contact import (20 / 15 min) ──────────────────────
setInterval(() => {
  if (state.sock && state.connectionStatus === 'connected') {
    processImportQueue(state.sock).catch(() => {});
  }
}, 15 * 60 * 1000);
// Also run once 30s after start so first batch doesn't wait 15min
setTimeout(() => {
  if (state.sock && state.connectionStatus === 'connected') {
    processImportQueue(state.sock).catch(() => {});
  }
}, 30000);

async function main() {
  // Expose helpers so the websocket/REST layer routes through the single
  // pairing entrypoint and the socket-liveness guard.
  state.requestPairing = requestPairing;
  state.botSnapshot = botSnapshot;
  state.isSocketLive = () => isSocketLive();
  try { startAPI(state, () => safeStartBot('api-restart')); } catch (e) { console.log('⚠️ API server not started:', e.message); }
  await safeStartBot('initial');
}

main().catch((e) => {
  console.error('💥 main() failed:', e.message);
  setTimeout(() => safeStartBot('main-retry'), 5000);
});
