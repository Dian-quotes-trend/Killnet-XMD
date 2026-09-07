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

const SESSION_DIR = path.resolve(config.sessionFolder || './session');
const DATA_DIR = path.resolve('./data');
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}

function saveJson(name, value) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(`Failed to save ${name}:`, error.message);
  }
}

function normalizeJid(value) {
  if (!value) return '';
  const jid = String(value).trim();
  if (jid.includes('@')) return jidNormalizedUser(jid);
  const digits = jid.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function senderJid(msg) {
  const key = msg?.key || {};
  if (key.participant?.endsWith('@lid') && key.participantPn) return key.participantPn;
  if (key.participant?.endsWith('@lid') && key.participantAlt) return key.participantAlt;
  if (key.remoteJid?.endsWith('@lid') && key.senderPn) return key.senderPn;
  return key.participant || key.remoteJid || '';
}

function remoteJid(msg) {
  const key = msg?.key || {};
  if (key.remoteJid?.endsWith('@lid') && key.remoteJidAlt) return key.remoteJidAlt;
  if (key.remoteJid?.endsWith('@lid') && key.senderPn) return key.senderPn;
  return key.remoteJid || '';
}

function textFromMessage(msg) {
  const message = msg?.message || {};
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  ).trim();
}

function isGroup(jid) { return jid?.endsWith('@g.us'); }
function isStatus(jid) { return jid === 'status@broadcast'; }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

const settings = {
  prefix: config.prefix || '.',
  botName: config.botName,
  ownerNumber: config.ownerNumber,
  mode: 'public',
  autoRead: false,
  autoTyping: false,
  autoRecording: false,
  autoStatusView: false,
  autoReact: false,
  autoLikeStatus: false,
  autoReply: { enabled: false, message: 'Hello! I am currently unavailable.' },
  antiDelete: false,
  antiCall: {
    enabled: false,
    mode: 'decline',
    message: '🚫 Calls are not allowed. Please send a message instead.',
  },
  presenceMode: 'online',
  autoReactEmojis: ['❤️', '🔥', '👍', '😂', '🎉'],
  statusReactEmojis: ['👍', '❤️', '🔥', '😮', '💯'],
};

Object.assign(settings, loadJson('settings.json', {}));
settings.autoReply = { ...settings.autoReply, ...loadJson('autoreply.json', {}) };
settings.antiCall = { ...settings.antiCall, ...loadJson('anticall.json', {}) };
settings.autoReactEmojis = Array.isArray(settings.autoReactEmojis) ? settings.autoReactEmojis : ['❤️'];
settings.statusReactEmojis = Array.isArray(settings.statusReactEmojis) ? settings.statusReactEmojis : ['❤️'];

const bannedUsers = new Set(loadJson('banned.json', []));
const antilinkGroups = new Set(loadJson('antilink.json', []));
const recentMessages = new Map();
const MAX_RECENT_MESSAGES = 1000;

function persistSettings() {
  saveJson('settings.json', settings);
  saveJson('autoreply.json', settings.autoReply);
  saveJson('anticall.json', settings.antiCall);
}

function rememberMessage(msg) {
  if (!msg?.key?.id || !msg.message) return;
  recentMessages.set(msg.key.id, msg);
  while (recentMessages.size > MAX_RECENT_MESSAGES) {
    recentMessages.delete(recentMessages.keys().next().value);
  }
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)] || '👍';
}

function uptime() {
  const total = Math.floor(process.uptime());
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

function ownerJid() { return normalizeJid(settings.ownerNumber); }

function isOwner(msg) {
  const sender = normalizeJid(senderJid(msg));
  const owner = ownerJid();
  return Boolean(owner && sender && sender === owner);
}

function commandFrom(text) {
  if (!text.startsWith(settings.prefix)) return null;
  const body = text.slice(settings.prefix.length).trim();
  if (!body) return null;
  const [name, ...args] = body.split(/\s+/);
  return { name: name.toLowerCase(), args };
}

async function send(sock, jid, text, msg, extra = {}) {
  return sock.sendMessage(jid, { text, ...extra }, msg ? { quoted: msg } : undefined);
}

async function isAdmin(sock, group, user) {
  try {
    const metadata = await sock.groupMetadata(group);
    return metadata.participants.some((p) => normalizeJid(p.id) === normalizeJid(user) && ['admin', 'superadmin'].includes(p.admin));
  } catch {
    return false;
  }
}

async function tagAll(sock, msg, hidden = false) {
  const jid = remoteJid(msg);
  if (!isGroup(jid)) return send(sock, jid, 'ℹ️ This command is for groups only.', msg);
  const metadata = await sock.groupMetadata(jid);
  const mentions = metadata.participants.map((p) => p.id);
  const text = hidden
    ? '📢 Attention everyone!'
    : `📢 *${settings.botName} — Tag All*\n\n${mentions.map((id) => `@${id.split('@')[0]}`).join('\n')}`;
  return sock.sendMessage(jid, { text, mentions }, { quoted: msg });
}

const commands = new Map();
const command = (name, description, handler, ownerOnly = false) => commands.set(name, { description, handler, ownerOnly });

command('ping', 'Check bot response time', async (sock, msg) => {
  const start = Date.now();
  await send(sock, remoteJid(msg), '🏓 Pong!', msg);
  return send(sock, remoteJid(msg), `⚡ ${Date.now() - start}ms`, msg);
});

command('alive', 'Show bot status', async (sock, msg) => send(sock, remoteJid(msg), `🤖 *${settings.botName}*\n\n✅ Online\n⏱ Uptime: ${uptime()}\n📨 Prefix: ${settings.prefix}\n⚙️ Mode: ${settings.mode}`, msg));
command('owner', 'Show configured owner', async (sock, msg) => send(sock, remoteJid(msg), `👑 Owner: ${settings.ownerNumber || 'Not configured'}`, msg));
command('info', 'Show runtime information', async (sock, msg) => send(sock, remoteJid(msg), `📊 *${settings.botName}*\n\n• Version: 3.0.0\n• Node: ${process.version}\n• Uptime: ${uptime()}\n• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`, msg));

command('menu', 'List commands', async (sock, msg) => {
  const lines = [`🤖 *${settings.botName}*`, '', `Prefix: ${settings.prefix}`, ''];
  for (const [name, item] of commands) lines.push(`${settings.prefix}${name} — ${item.description}${item.ownerOnly ? ' 👑' : ''}`);
  return send(sock, remoteJid(msg), lines.join('\n'), msg);
});
command('help', 'Show command list', async (sock, msg) => commands.get('menu').handler(sock, msg));

command('settings', 'Show automation settings', async (sock, msg) => {
  return send(sock, remoteJid(msg), `⚙️ *Settings*\n\n• Auto read: ${settings.autoRead ? 'ON' : 'OFF'}\n• Auto typing: ${settings.autoTyping ? 'ON' : 'OFF'}\n• Auto recording: ${settings.autoRecording ? 'ON' : 'OFF'}\n• Auto status view: ${settings.autoStatusView ? 'ON' : 'OFF'}\n• Auto react: ${settings.autoReact ? 'ON' : 'OFF'}\n• Status react: ${settings.autoLikeStatus ? 'ON' : 'OFF'}\n• Auto reply: ${settings.autoReply.enabled ? 'ON' : 'OFF'}\n• Anti delete: ${settings.antiDelete ? 'ON' : 'OFF'}\n• Anti call: ${settings.antiCall.enabled ? 'ON' : 'OFF'}\n• Presence: ${settings.presenceMode}\n• Mode: ${settings.mode}`, msg);
}, true);

for (const [name, key] of [['autoread', 'autoRead'], ['autotyping', 'autoTyping'], ['autorecording', 'autoRecording'], ['autostatus', 'autoStatusView'], ['autoreact', 'autoReact'], ['autoreactstatus', 'autoLikeStatus'], ['antidelete', 'antiDelete']]) {
  command(name, `Toggle ${key}`, async (sock, msg) => {
    settings[key] = !settings[key];
    persistSettings();
    return send(sock, remoteJid(msg), `✅ ${name}: ${settings[key] ? 'ON' : 'OFF'}`, msg);
  }, true);
}

command('autoreply', 'Toggle or set automatic replies', async (sock, msg, args) => {
  if (args.length) {
    settings.autoReply.message = args.join(' ');
    settings.autoReply.enabled = true;
  } else settings.autoReply.enabled = !settings.autoReply.enabled;
  persistSettings();
  return send(sock, remoteJid(msg), `✅ Auto reply ${settings.autoReply.enabled ? 'ON' : 'OFF'}${args.length ? `\nMessage: ${settings.autoReply.message}` : ''}`, msg);
}, true);

command('presence', 'Set online/lastseen/typing/recording/off', async (sock, msg, args) => {
  const mode = (args[0] || '').toLowerCase();
  const valid = ['online', 'lastseen', 'typing', 'recording', 'off'];
  if (!valid.includes(mode)) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}presence ${valid.join('/')}`, msg);
  settings.presenceMode = mode;
  persistSettings();
  return send(sock, remoteJid(msg), `✅ Presence: ${mode}`, msg);
}, true);

command('anticall', 'Toggle anti-call', async (sock, msg) => {
  settings.antiCall.enabled = !settings.antiCall.enabled;
  persistSettings();
  return send(sock, remoteJid(msg), `✅ Anti-call: ${settings.antiCall.enabled ? 'ON' : 'OFF'}`, msg);
}, true);

command('anticallmsg', 'Set anti-call message', async (sock, msg, args) => {
  if (!args.length) return send(sock, remoteJid(msg), `Current: ${settings.antiCall.message}`, msg);
  settings.antiCall.message = args.join(' ');
  persistSettings();
  return send(sock, remoteJid(msg), '✅ Anti-call message updated.', msg);
}, true);

command('tagall', 'Tag all group members', async (sock, msg) => tagAll(sock, msg));
command('hidetag', 'Mention all members invisibly', async (sock, msg) => tagAll(sock, msg, true));

command('delete', 'Delete a replied message', async (sock, msg) => {
  const jid = remoteJid(msg);
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.stanzaId) return send(sock, jid, '📎 Reply to a message to delete it.', msg);
  await sock.sendMessage(jid, {
    delete: {
      remoteJid: jid,
      fromMe: ctx.participant ? normalizeJid(ctx.participant) === normalizeJid(sock.user?.id) : false,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
  });
});
command('del', 'Delete shortcut', async (sock, msg) => commands.get('delete').handler(sock, msg));

command('report', 'Send a report to the bot owner', async (sock, msg, args) => {
  if (!args.length) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}report <message>`, msg);
  const owner = ownerJid();
  if (!owner) return send(sock, remoteJid(msg), '❌ OWNER_NUMBER is not configured.', msg);
  const sender = senderJid(msg) || remoteJid(msg);
  await sock.sendMessage(owner, { text: `📢 *Killnet XMD Report*\n\nFrom: @${sender.split('@')[0]}\n\n${args.join(' ')}`, mentions: [sender] });
  return send(sock, remoteJid(msg), '✅ Report sent to the bot owner.', msg);
});

command('mode', 'Switch public/private mode', async (sock, msg, args) => {
  const mode = (args[0] || '').toLowerCase();
  if (!['public', 'private'].includes(mode)) return send(sock, remoteJid(msg), `Current mode: ${settings.mode}\nUsage: ${settings.prefix}mode public/private`, msg);
  settings.mode = mode;
  persistSettings();
  return send(sock, remoteJid(msg), `✅ Mode: ${mode}`, msg);
}, true);

command('setprefix', 'Change command prefix', async (sock, msg, args) => {
  const prefix = args[0];
  if (!prefix || prefix.length > 2) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}setprefix <prefix>`, msg);
  settings.prefix = prefix;
  persistSettings();
  return send(sock, remoteJid(msg), `✅ Prefix changed to ${prefix}`, msg);
}, true);

command('antilink', 'Toggle anti-link for the current group', async (sock, msg) => {
  const jid = remoteJid(msg);
  if (!isGroup(jid)) return send(sock, jid, 'ℹ️ Groups only.', msg);
  if (antilinkGroups.has(jid)) antilinkGroups.delete(jid);
  else antilinkGroups.add(jid);
  saveJson('antilink.json', [...antilinkGroups]);
  return send(sock, jid, `✅ Anti-link: ${antilinkGroups.has(jid) ? 'ON' : 'OFF'}`, msg);
}, true);

command('ban', 'Ban a sender', async (sock, msg, args) => {
  const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || normalizeJid(args[0]);
  if (!target) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}ban @user`, msg);
  bannedUsers.add(target);
  saveJson('banned.json', [...bannedUsers]);
  return send(sock, remoteJid(msg), `🚫 Banned ${target.split('@')[0]}`, msg);
}, true);

command('unban', 'Unban a sender', async (sock, msg, args) => {
  const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || normalizeJid(args[0]);
  if (!target) return send(sock, remoteJid(msg), `Usage: ${settings.prefix}unban @user`, msg);
  bannedUsers.delete(target);
  saveJson('banned.json', [...bannedUsers]);
  return send(sock, remoteJid(msg), `✅ Unbanned ${target.split('@')[0]}`, msg);
}, true);

async function handleIncoming(sock, msg) {
  if (!msg?.message || !msg.key?.remoteJid) return;
  rememberMessage(msg);

  const jid = remoteJid(msg);
  const sender = normalizeJid(senderJid(msg));

  if (settings.autoRead && !isStatus(jid)) {
    try { await sock.readMessages([msg.key]); } catch {}
  }

  if (isStatus(jid)) {
    if (settings.autoStatusView) {
      try { await sock.readMessages([msg.key]); } catch {}
    }
    if (settings.autoLikeStatus && !msg.key.fromMe) {
      try {
        await sock.sendMessage(jid, { react: { text: pick(settings.statusReactEmojis), key: msg.key } });
      } catch {}
    }
    return;
  }

  if (!msg.key.fromMe && bannedUsers.has(sender)) return;

  if (!msg.key.fromMe && isGroup(jid) && antilinkGroups.has(jid)) {
    const body = textFromMessage(msg);
    if (/https?:\/\/|www\./i.test(body) && !(await isAdmin(sock, jid, sender))) {
      try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
      return;
    }
  }

  if (!msg.key.fromMe && settings.autoReact) {
    try { await sock.sendMessage(jid, { react: { text: pick(settings.autoReactEmojis), key: msg.key } }); } catch {}
  }

  const text = textFromMessage(msg);
  const cmd = commandFrom(text);

  if (!msg.key.fromMe && settings.autoReply.enabled && !cmd) {
    if (settings.autoTyping) {
      try { await sock.sendPresenceUpdate('composing', jid); } catch {}
    }
    if (settings.autoRecording) {
      try { await sock.sendPresenceUpdate('recording', jid); } catch {}
    }
    await send(sock, jid, settings.autoReply.message, msg);
  }

  if (!cmd) return;

  const item = commands.get(cmd.name);
  if (!item) return;
  if (item.ownerOnly && !isOwner(msg)) return send(sock, jid, '⛔ Owner only.', msg);
  if (settings.mode === 'private' && !msg.key.fromMe && !isOwner(msg)) return;

  try {
    if (settings.autoTyping && !['autotyping', 'autorecording'].includes(cmd.name)) {
      await sock.sendPresenceUpdate('composing', jid);
    }
    await item.handler(sock, msg, cmd.args);
  } catch (error) {
    console.error(`Command ${cmd.name} failed:`, error);
    await send(sock, jid, `❌ ${cmd.name} failed: ${error.message || 'unknown error'}`, msg);
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: settings.presenceMode === 'online',
    shouldIgnoreJid: (jid) => jid === 'status@broadcast' && !settings.autoStatusView && !settings.autoLikeStatus,
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr && (config.pairMode === 'qr' || config.pairMode === 'both')) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log(`✅ ${settings.botName} connected as ${sock.user?.id || 'unknown'}`);
      try {
        const presence = settings.presenceMode === 'online' ? 'available' : 'unavailable';
        await sock.sendPresenceUpdate(presence);
      } catch {}
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error instanceof Boom
      ? lastDisconnect.error.output.statusCode
      : lastDisconnect?.error?.output?.statusCode;

    console.log(`⚠️ Connection closed (code ${code ?? 'unknown'})`);

    if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
      console.error('🔐 Session logged out. Delete session/ and pair again.');
      return;
    }

    if (code === DisconnectReason.restartRequired || code === 515) {
      console.log('🔄 WhatsApp requested a socket restart. Reconnecting...');
      await delay(1000);
      return connect();
    }

    await delay(code === DisconnectReason.connectionReplaced ? 10000 : 3000);
    return connect();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await handleIncoming(sock, msg); }
      catch (error) { console.error('Message handler failed:', error.message); }
    }
  });

  sock.ev.on('messages.delete', async ({ keys }) => {
    if (!settings.antiDelete || !Array.isArray(keys)) return;
    for (const key of keys) {
      const original = recentMessages.get(key.id);
      if (!original?.message) continue;
      const jid = key.remoteJid;
      const body = textFromMessage(original);
      if (!body) continue;
      try { await send(sock, jid, `🗑️ *Deleted message recovered*\n\n${body}`); } catch {}
    }
  });

  sock.ev.on('call', async (calls) => {
    if (!settings.antiCall.enabled) return;
    for (const call of calls || []) {
      try {
        if (settings.antiCall.mode === 'decline') await sock.rejectCall(call.id, call.from);
        if (settings.antiCall.message) await sock.sendMessage(call.from, { text: settings.antiCall.message });
      } catch (error) { console.error('Anti-call failed:', error.message); }
    }
  });

  if (!state.creds.registered && config.pairMode !== 'qr') {
    const phone = String(await ask('📱 Enter WhatsApp number with country code (digits only): ')).replace(/\D/g, '');
    if (phone.length < 10) throw new Error('Invalid phone number.');
    if (!pairingRequested) {
      pairingRequested = true;
      await delay(1500);
      try {
        const code = await sock.requestPairingCode(phone);
        console.log(`\n🔗 Pairing code: ${code}`);
        console.log('WhatsApp → Linked devices → Link a device → Link with phone number instead.\n');
      } catch (error) {
        console.error('❌ Pairing code request failed:', error.message);
      }
    }
  }

  return sock;
}

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

connect().catch((error) => {
  console.error('❌ Startup failed:', error);
  setTimeout(() => connect().catch((retryError) => console.error('❌ Retry failed:', retryError)), 5000);
});
