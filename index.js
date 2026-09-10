const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { createLegacyDispatchAdapter } = require('./lib/live-command-adapter');
const { createLiveLifecycle } = require('./lib/live-lifecycle');
const { createMessageContext } = require('./lib/message-context');

const SESSION_DIR = path.resolve(config.sessionFolder || './session');
const DATA_DIR = path.resolve('./data');
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; } }
function saveJson(name, value) { try { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2)); } catch {} }
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function normalizeJid(value) { if (!value) return ''; const raw = String(value).trim(); if (raw.includes('@')) return jidNormalizedUser(raw); const number = digits(raw); return number ? `${number}@s.whatsapp.net` : ''; }
function phoneOf(value) { return digits(String(value || '').split('@')[0]); }
function identityCandidates(msg) { const key = msg?.key || {}; return [key.participant, key.participantAlt, key.participantPn, key.remoteJid, key.remoteJidAlt, key.senderPn].filter(Boolean).map(phoneOf).filter(Boolean); }
function senderJid(msg) { const key = msg?.key || {}; return key.participantAlt || key.participantPn || key.participant || key.remoteJidAlt || key.senderPn || key.remoteJid || ''; }
function remoteJid(msg) { const key = msg?.key || {}; return key.remoteJidAlt || key.remoteJid || ''; }
function textFromMessage(msg) { const m = msg?.message || {}; return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '').trim(); }
function isGroup(jid) { return jid?.endsWith('@g.us'); }
function isStatus(jid) { return jid === 'status@broadcast'; }
function ask(question) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); })); }
function uptime() { const t = Math.floor(process.uptime()); return `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m ${t % 60}s`; }
function pick(list) { return list[Math.floor(Math.random() * list.length)] || '👍'; }
function log(title, message = '') { const line = message ? `│ ${message}` : '│'; console.log(`\n╭── ${title} ─────────────────`); console.log(line); console.log('╰────────────────────────────'); }

const settings = { prefix: config.prefix || '.', botName: config.botName || 'Killnet XMD', creator: config.creator || 'Dian Sybex Tech', ownerNumber: config.ownerNumber || '', mode: 'public', autoRead: false, autoReact: false, autoReply: { enabled: false, message: 'Hello! I am currently unavailable.' }, antiDelete: false, antiCall: { enabled: false, mode: 'decline', message: '🚫 Calls are not allowed. Please send a message instead.' }, presenceMode: 'online', autoReactEmojis: ['❤️', '🔥', '👍', '😂', '🎉'] };
Object.assign(settings, loadJson('settings.json', {}));
settings.autoReply = { enabled: false, message: 'Hello! I am currently unavailable.', ...settings.autoReply, ...loadJson('autoreply.json', {}) };
settings.antiCall = { enabled: false, mode: 'decline', message: '🚫 Calls are not allowed. Please send a message instead.', ...settings.antiCall, ...loadJson('anticall.json', {}) };
settings.autoReactEmojis = Array.isArray(settings.autoReactEmojis) && settings.autoReactEmojis.length ? settings.autoReactEmojis : ['❤️'];
const bannedUsers = new Set(loadJson('banned.json', []));
const antilinkGroups = new Set(loadJson('antilink.json', []));
const recentMessages = new Map();
const MAX_RECENT_MESSAGES = 1000;
function persistSettings() { saveJson('settings.json', settings); saveJson('autoreply.json', settings.autoReply); saveJson('anticall.json', settings.antiCall); }
function rememberMessage(msg) { if (!msg?.key?.id || !msg.message) return; recentMessages.set(msg.key.id, msg); while (recentMessages.size > MAX_RECENT_MESSAGES) recentMessages.delete(recentMessages.keys().next().value); }
function ownerNumber() { return digits(settings.ownerNumber); }
function masterNumber() { return digits(config.masterSudo); }
function isOwner(msg) { return !!ownerNumber() && (msg?.key?.fromMe || identityCandidates(msg).includes(ownerNumber())); }
function isMasterSudo(msg) { return !!masterNumber() && identityCandidates(msg).includes(masterNumber()); }
function hasAdminAccess(msg) { return isOwner(msg) || isMasterSudo(msg); }
function accessLabel(msg) { if (isMasterSudo(msg)) return 'MASTER SUDO'; if (isOwner(msg)) return 'OWNER'; return 'USER'; }
async function send(sock, jid, text, msg, extra = {}) { return sock.sendMessage(jid, { text, ...extra }, msg ? { quoted: msg } : undefined); }
async function tagAll(sock, msg, hidden = false) { const jid = remoteJid(msg); if (!isGroup(jid)) return send(sock, jid, 'ℹ️ This command is for groups only.', msg); const metadata = await sock.groupMetadata(jid); const mentions = metadata.participants.map((p) => p.id); const body = hidden ? '📢 Attention everyone!' : `📢 *${settings.botName} — TAG ALL*\n\n${mentions.map((id) => `@${id.split('@')[0]}`).join('\n')}`; return sock.sendMessage(jid, { text: body, mentions }, { quoted: msg }); }

const commands = new Map();
const command = (name, description, handler, ownerOnly = false, category = 'GENERAL') => commands.set(name, { description, handler, ownerOnly, category });
let live;
command('ping', 'Fast connection check', async (sock, msg) => send(sock, remoteJid(msg), `🏓 *PONG* • ${Date.now() % 1000}ms`, msg));
command('alive', 'Show bot status', async (sock, msg) => send(sock, remoteJid(msg), `╭━━〔 *${settings.botName}* 〕━━╮\n┃ 🟢 Online & ready\n┃ 🔐 Access: ${accessLabel(msg)}\n┃ ⏱ Uptime: ${uptime()}\n┃ ⚙️ Mode: ${settings.mode}\n┃ 🔣 Prefix: ${settings.prefix}\n╰━━━━━━━━━━━━━━━━━━━━╯`, msg));
command('owner', 'Show configured owner and master', async (sock, msg) => send(sock, remoteJid(msg), `👑 *Owner:* ${settings.ownerNumber || 'Not configured'}\n🛡️ *Master Sudo:* ${config.masterSudo || 'Not configured'}\n🔐 *Your access:* ${accessLabel(msg)}`, msg));
command('info', 'Show runtime information', async (sock, msg) => send(sock, remoteJid(msg), `╭━━〔 *${settings.botName}* 〕━━╮\n┃ ⚡ Runtime: Node ${process.version}\n┃ ⏱ Uptime: ${uptime()}\n┃ 💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n┃ 👨‍💻 ${settings.creator}\n╰━━━━━━━━━━━━━━━━━━━━╯`, msg));
command('menu', 'Show the branded command center', async (sock, msg) => { const order = ['CORE', 'INFO', 'CONFIG', 'AUTOMATION', 'GROUP', 'MODERATION', 'ADMIN', 'UTILITY']; const icons = { CORE: '⚡', INFO: 'ℹ️', CONFIG: '⚙️', AUTOMATION: '🤖', GROUP: '👥', MODERATION: '🛡️', ADMIN: '🔐', UTILITY: '🧰' }; const lines = [`╭━━━━━━━━━━━━━━━━━━━━╮`, `┃   *${settings.botName}*`, `┃  *Dian Sybex Tech*`, `┣━━━━━━━━━━━━━━━━━━━━┫`, `┃ ⚡ *COMMAND CENTER*`, `┃ 🔣 Prefix: *${settings.prefix}*`, `┃ 🌐 Mode: *${settings.mode.toUpperCase()}*`, `╰━━━━━━━━━━━━━━━━━━━━╯`, '']; const registry = live.registry; for (const category of order) { const items = registry.list(category); if (!items.length) continue; lines.push(`${icons[category] || '•'} *${category}*`); for (const item of items) lines.push(`  ${settings.prefix}${item.name} — ${item.description}${item.ownerOnly ? ' 🔒' : ''}`); lines.push(''); } lines.push(`💡 *${settings.prefix}help* is the menu shortcut`); lines.push(`🔒 = owner/master only`); lines.push(`╰─ *Powered by ${settings.creator}* ─╯`); return send(sock, remoteJid(msg), lines.join('\n'), msg); });
command('settings', 'Show active automation settings', async (sock, msg) => send(sock, remoteJid(msg), `╭━━〔 *ACTIVE SETTINGS* 〕━━╮\n┃ 📖 Auto-read: ${settings.autoRead ? 'ON' : 'OFF'}\n┃ ❤️ Auto-react: ${settings.autoReact ? 'ON' : 'OFF'}\n┃ 💬 Auto-reply: ${settings.autoReply.enabled ? 'ON' : 'OFF'}\n┃ 🛡️ Anti-delete: ${settings.antiDelete ? 'ON' : 'OFF'}\n┃ 📵 Anti-call: ${settings.antiCall.enabled ? 'ON' : 'OFF'}\n┃ 👁️ Presence: ${settings.presenceMode}\n┃ 🌐 Mode: ${settings.mode}\n╰━━━━━━━━━━━━━━━━━━━━╯`, msg), true, 'ADMIN');
for (const [name, key, desc] of [['autoread', 'autoRead', 'Toggle automatic read receipts'], ['autoreact', 'autoReact', 'Toggle automatic message reactions'], ['antidelete', 'antiDelete', 'Toggle deleted-message recovery']]) command(name, desc, async (sock, msg) => { settings[key] = !settings[key]; persistSettings(); return send(sock, remoteJid(msg), `✅ *${name}*: ${settings[key] ? 'ON' : 'OFF'}`, msg); }, true, 'AUTOMATION');
command('autoreply', 'Toggle or set automatic replies', async (sock, msg, args) => { if (args.length) { settings.autoReply.message = args.join(' '); settings.autoReply.enabled = true; } else settings.autoReply.enabled = !settings.autoReply.enabled; persistSettings(); return send(sock, remoteJid(msg), `✅ Auto-reply: ${settings.autoReply.enabled ? 'ON' : 'OFF'}${args.length ? `\n📝 ${settings.autoReply.message}` : ''}`, msg); }, true, 'AUTOMATION');
command('presence', 'Set online or off', async (sock, msg, args) => { const mode = (args[0] || '').toLowerCase(); if (!['online', 'off'].includes(mode)) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}presence online/off`, msg); settings.presenceMode = mode; persistSettings(); return send(sock, remoteJid(msg), `✅ Presence: ${mode}`, msg); }, true, 'AUTOMATION');
command('anticall', 'Toggle anti-call protection', async (sock, msg) => { settings.antiCall.enabled = !settings.antiCall.enabled; persistSettings(); return send(sock, remoteJid(msg), `✅ Anti-call: ${settings.antiCall.enabled ? 'ON' : 'OFF'}`, msg); }, true, 'AUTOMATION');
command('anticallmsg', 'Set the anti-call reply', async (sock, msg, args) => { if (!args.length) return send(sock, remoteJid(msg), settings.antiCall.message, msg); settings.antiCall.message = args.join(' '); persistSettings(); return send(sock, remoteJid(msg), '✅ Anti-call message updated.', msg); }, true, 'AUTOMATION');
command('tagall', 'Mention all group members', async (sock, msg) => tagAll(sock, msg), false, 'GROUP');
command('hidetag', 'Mention everyone without visible tags', async (sock, msg) => tagAll(sock, msg, true), false, 'GROUP');
command('antilink', 'Toggle link protection for this group', async (sock, msg) => { const jid = remoteJid(msg); if (!isGroup(jid)) return send(sock, jid, 'ℹ️ Groups only.', msg); if (antilinkGroups.has(jid)) antilinkGroups.delete(jid); else antilinkGroups.add(jid); saveJson('antilink.json', [...antilinkGroups]); return send(sock, jid, `✅ Anti-link: ${antilinkGroups.has(jid) ? 'ON' : 'OFF'}`, msg); }, true, 'GROUP');
command('delete', 'Delete a replied message', async (sock, msg) => { const jid = remoteJid(msg); const ctx = msg.message?.extendedTextMessage?.contextInfo; if (!ctx?.stanzaId) return send(sock, jid, '📎 Reply to a message to delete it.', msg); return sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: !!msg.key.fromMe, id: ctx.stanzaId, participant: ctx.participant } }); }, false, 'GROUP');
command('mode', 'Switch public or private mode', async (sock, msg, args) => { const mode = (args[0] || '').toLowerCase(); if (!['public', 'private'].includes(mode)) return send(sock, remoteJid(msg), `Current: ${settings.mode}\nUsage: ${settings.prefix}mode public/private`, msg); settings.mode = mode; persistSettings(); return send(sock, remoteJid(msg), `✅ Bot mode: ${mode}`, msg); }, true, 'ADMIN');
command('setprefix', 'Change the command prefix', async (sock, msg, args) => { const prefix = args[0]; if (!prefix || prefix.length > 2) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}setprefix <prefix>`, msg); settings.prefix = prefix; persistSettings(); return send(sock, remoteJid(msg), `✅ Prefix changed to ${prefix}`, msg); }, true, 'ADMIN');
command('ban', 'Ban a user by reply or number', async (sock, msg, args) => { const target = msg.message?.extendedTextMessage?.contextInfo?.participant || args[0]; const number = phoneOf(target); if (!number) return send(sock, remoteJid(msg), 'Usage: reply to a user or provide a phone number.', msg); bannedUsers.add(number); saveJson('banned.json', [...bannedUsers]); return send(sock, remoteJid(msg), `🚫 Banned: ${number}`, msg); }, true, 'ADMIN');
command('unban', 'Remove a user ban', async (sock, msg, args) => { const number = phoneOf(args[0]); if (!number) return send(sock, remoteJid(msg), 'Usage: .unban <phone>', msg); bannedUsers.delete(number); saveJson('banned.json', [...bannedUsers]); return send(sock, remoteJid(msg), `✅ Unbanned: ${number}`, msg); }, true, 'ADMIN');
command('report', 'Report a message to the owner', async (sock, msg) => { const owner = normalizeJid(settings.ownerNumber); if (!owner) return send(sock, remoteJid(msg), '❌ Owner number is not configured.', msg); const text = textFromMessage(msg) || '(no text)'; await send(sock, owner, `🚨 *REPORT*\n\nFrom: ${senderJid(msg)}\nChat: ${remoteJid(msg)}\n\n${text}`, msg); return send(sock, remoteJid(msg), '✅ Report sent to the owner.', msg); }, false, 'ADMIN');

const runtimeState = { lifecycleStable: false, connected: false, credentialsReady: false };
live = createLegacyDispatchAdapter(commands, { getActor: (ctx) => ctx.actor });
const lifecycle = createLiveLifecycle({ dbPath: path.join(DATA_DIR, 'automation.json'), pick, emojis: settings.autoReactEmojis, isStable: () => runtimeState.lifecycleStable, runAutomations: false, runModeration: false });

async function handleIncoming(sock, msg) {
  if (!msg?.message) return;
  rememberMessage(msg);
  const jid = remoteJid(msg);
  const text = textFromMessage(msg);
  const trimmed = text.startsWith(settings.prefix) ? text.slice(settings.prefix.length).trim() : '';
  const parsed = trimmed ? { name: trimmed.split(/\s+/)[0]?.toLowerCase(), args: trimmed.split(/\s+/).slice(1) } : null;
  const ctx = createMessageContext(msg, { text, command: parsed, sock, isGroup: isGroup(jid), isStatus: isStatus(jid), isOwner: isOwner(msg), isMasterSudo: isMasterSudo(msg) });
  if (isStatus(jid)) return;
  if (bannedUsers.has(phoneOf(senderJid(msg)))) return;
  if (antilinkGroups.has(jid) && /(?:https?:\/\/|www\.)\S+/i.test(text) && !hasAdminAccess(msg)) { await sock.sendMessage(jid, { delete: msg.key }).catch(() => {}); return; }
  if (parsed) {
    if (settings.mode === 'private' && !msg.key.fromMe && !hasAdminAccess(msg)) return;
    try { await live.dispatch(ctx); } catch (error) { logger.error({ err: error, command: parsed.name }, 'command dispatch failed'); }
    return;
  }
  if (settings.autoRead) void sock.readMessages([msg.key]).catch(() => {});
  if (settings.autoReact && !msg.key.fromMe) void sock.sendMessage(jid, { react: { text: pick(settings.autoReactEmojis), key: msg.key } }).catch(() => {});
  if (settings.autoReply.enabled && text && !msg.key.fromMe) void send(sock, jid, settings.autoReply.message, msg).catch(() => {});
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const hasSession = !!state.creds.registered;
  let pairingRequested = false; let pairingNumber = '';
  const sock = makeWASocket({ auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, browser: Browsers.ubuntu('Chrome'), printQRInTerminal: false, generateHighQualityLinkPreview: false });
  sock.ev.on('creds.update', saveCreds);
  lifecycle.attach(sock);
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr && config.showQr) { log('QR CODE', 'Scan the QR code below with WhatsApp > Linked devices'); qrcode.generate(qr, { small: true }); }
    if ((connection === 'connecting' || qr) && config.usePairingCode && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try { pairingNumber = digits(process.env.PAIR_NUMBER) || await ask('📱 Enter WhatsApp number with country code: '); if (!pairingNumber) throw new Error('No phone number supplied'); log('PAIRING', `Requesting pairing code for +${pairingNumber}`); const code = await sock.requestPairingCode(pairingNumber); console.log(`\n╭━━━〔 PAIR CODE 〕━━━╮\n┃  🔐 ${code}\n┃  📱 +${pairingNumber}\n╰━━━━━━━━━━━━━━━━━━╯`); console.log('ℹ️ Enter this code in WhatsApp → Linked devices → Link with phone number.'); } catch (error) { pairingRequested = false; console.error(`❌ Pairing failed: ${error.message}`); }
    }
    if (connection === 'connecting') { runtimeState.connected = false; runtimeState.lifecycleStable = false; console.log('🔄 Connecting to WhatsApp...'); }
    if (connection === 'open') {
      runtimeState.connected = true; runtimeState.credentialsReady = true; runtimeState.lifecycleStable = true;
      const connected = phoneOf(sock.user?.id) || phoneOf(sock.user?.jid) || pairingNumber || 'unknown';
      log('WHATSAPP CONNECTED', `🟢 Connected successfully\n│ 📱 Number: +${connected}\n│ 👤 Account: ${sock.user?.name || 'WhatsApp account'}\n│ 🔗 Method: ${hasSession ? 'Existing credentials' : (pairingNumber ? 'Pairing code' : 'QR code')}\n│ 🛡️ Owner: +${ownerNumber() || 'not set'}\n│ 👑 Master Sudo: +${masterNumber() || 'not set'}`);
      try { await sock.sendPresenceUpdate(settings.presenceMode === 'online' ? 'available' : 'unavailable'); } catch {}
      return;
    }
    if (connection !== 'close') return;
    runtimeState.connected = false; runtimeState.lifecycleStable = false;
    const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) { console.error('🔴 WhatsApp session logged out/forbidden. Delete the session folder and pair again.'); return; }
    console.warn(`🟠 WhatsApp connection closed (code ${code || 'unknown'}). Reconnecting...`); await delay(code === DisconnectReason.connectionReplaced ? 8000 : 2500); connect().catch((error) => console.error(`❌ Reconnect failed: ${error.message}`));
  });
  sock.ev.on('messages.upsert', async ({ messages }) => { for (const msg of messages || []) await handleIncoming(sock, msg); });
  sock.ev.on('messages.update', async (updates) => { if (!settings.antiDelete) return; for (const update of updates || []) { const protocol = update.update?.message?.protocolMessage; if (!protocol || protocol.type !== 0 || !protocol.key?.id) continue; const cached = recentMessages.get(protocol.key.id); if (!cached) continue; const jid = remoteJid(cached); const body = textFromMessage(cached); if (body) void send(sock, jid, `🗑️ *Deleted message recovered*\n\n${body}`, cached).catch(() => {}); } });
  sock.ev.on('call', async (calls) => { if (!settings.antiCall.enabled) return; for (const call of calls || []) try { if (call.status === 'offer' || call.status === 'ringing') { await sock.rejectCall(call.id, call.from); await sock.sendMessage(call.from, { text: settings.antiCall.message }); } } catch {} });
  return sock;
}

(async () => { console.log(`\n╔══════════════════════════════════╗\n║        KILLNET XMD STARTUP       ║\n║        ${settings.creator.padEnd(24, ' ')}║\n╚══════════════════════════════════╝`); console.log(`⚙️ Prefix: ${settings.prefix} | Mode: ${settings.mode} | Pair mode: ${config.pairMode}`); console.log(`👑 Owner: +${ownerNumber() || 'not configured'} | 🛡️ Master Sudo: +${masterNumber() || 'not configured'}`); await connect(); })().catch((error) => { console.error('💥 Fatal startup error:', error); process.exitCode = 1; });
