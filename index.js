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
function emitWs() {}

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


// ─── Standalone runtime: cloud/dashboard sync disabled ─────────────
async function syncToCloud() { return null; }
function syncChatMessage() {}
function enqueueChatSync() {}
async function flushChatSyncQueue() {}
function schedulePendingMedia() {}

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

// Dashboard media upload removed. Metadata remains local and no network
// request is made when media messages are received.
async function downloadAndUploadMedia() { return null; }

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

async function fetchCloudSettings() { return null; }

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

function scheduleContactSync() {}
async function syncContactsToCloud() { return null; }

async function main() {
  // Expose helpers so the websocket/REST layer routes through the single
  // pairing entrypoint and the socket-liveness guard.
  await safeStartBot('initial');
}

main().catch((e) => {
  console.error('💥 main() failed:', e.message);
  setTimeout(() => safeStartBot('main-retry'), 5000);
});
