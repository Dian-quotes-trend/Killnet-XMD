'use strict';

/**
 * Console boot/pairing layer.
 *
 * Keeps Baileys quiet and gives the operator a small, deterministic startup
 * timeline. The existing index.js owns the connection lifecycle; this module
 * only decorates the Baileys/auth entry points and normalizes its console UI.
 */

const baileys = require('@whiskeysockets/baileys');

const originalMakeWASocket = baileys.default;
const originalUseMultiFileAuthState = baileys.useMultiFileAuthState;
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let pairBox = null;
let installed = false;
let pairingAttempt = 0;
let lastCredLogAt = 0;

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function emit(level, message) {
  const line = `[${stamp()}] [${level}] ${String(message || '').replace(/\n+/g, ' ')}`;
  if (level === 'ERROR') return originalConsole.error(line);
  if (level === 'WARN') return originalConsole.warn(line);
  return originalConsole.log(line);
}

function cleanNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function validNumber(value) {
  const number = cleanNumber(value);
  return number.length >= 8 && number.length <= 15 ? number : '';
}

function normalizePairCode(code) {
  const raw = String(code || '').replace(/\s+/g, '');
  if (!raw) return '';
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function formatOriginal(_level, args) {
  const text = args.map((value) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');

  if (!text) return;

  if (pairBox) {
    if (/^╰/.test(text)) {
      pairBox = null;
      return;
    }
    const code = text.match(/🔐\s*([^\s]+)/);
    const number = text.match(/📱\s*([^\s]+)/);
    if (code) pairBox.code = normalizePairCode(code[1]);
    if (number) pairBox.number = number[1];
    return;
  }

  if (/╭━━━〔\s*PAIR CODE\s*〕━━━╮/.test(text)) {
    pairBox = { code: '', number: '' };
    return;
  }

  if (/^╭──\s*PAIRING/i.test(text) || /^╭──\s*WHATSAPP CONNECTED/i.test(text)) return;
  if (/^╔══.*KILLNET XMD STARTUP/i.test(text)) return;
  if (/^╚══/.test(text)) return;

  if (/^⚙️ Prefix:/.test(text)) return emit('BOOT', text.replace(/^⚙️\s*/, ''));
  if (/^👑 Owner:/.test(text)) return emit('BOOT', text.replace(/^👑\s*/, ''));
  if (/^🔄 Connecting to WhatsApp/i.test(text)) return emit('WA', 'Connecting to WhatsApp…');
  if (/^ℹ️ Enter this code/i.test(text)) return emit('PAIR', text.replace(/^ℹ️\s*/, ''));
  if (/^❌ Pairing failed:/i.test(text)) return emit('PAIR', text.replace(/^❌\s*/, 'FAILED: '));
  if (/^🔴 WhatsApp session/i.test(text)) return emit('WA', text.replace(/^🔴\s*/, 'SESSION: '));
  if (/^🟠 WhatsApp connection closed/i.test(text)) return emit('WA', text.replace(/^🟠\s*/, 'CLOSED: '));
  if (/^❌ Reconnect failed:/i.test(text)) return emit('WA', text.replace(/^❌\s*/, 'RECONNECT FAILED: '));
  if (/^💥 Fatal startup error:/i.test(text)) return emit('FATAL', text.replace(/^💥\s*/, ''));

  if (/🟢\s*Connected successfully/i.test(text)) {
    const cleaned = text.replace(/^│\s*/, '').replace(/\s*│\s*/g, ' • ');
    return emit('READY', cleaned.replace(/^🟢\s*/, ''));
  }
  if (/Requesting pairing code for/i.test(text)) return emit('PAIR', text.replace(/^│\s*/, ''));

  if (/^[╭╰│┃┣┫━]+$/.test(text.trim())) return;
  if (/^│\s*/.test(text)) return emit('INFO', text.replace(/^│\s*/, ''));

  return originalConsole.log(...args);
}

function installConsole() {
  if (installed) return;
  installed = true;

  console.log = (...args) => formatOriginal('LOG', args);
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    if (/^🟠 WhatsApp connection closed/i.test(text)) return emit('WA', text.replace(/^🟠\s*/, 'CLOSED: '));
    return emit('WARN', text);
  };
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (/^❌ Pairing failed:/i.test(text)) return emit('PAIR', text.replace(/^❌\s*/, 'FAILED: '));
    if (/^❌ Reconnect failed:/i.test(text)) return emit('WA', text.replace(/^❌\s*/, 'RECONNECT FAILED: '));
    if (/^💥 Fatal startup error:/i.test(text)) return emit('FATAL', text.replace(/^💥\s*/, ''));
    return emit('ERROR', text);
  };
}

function installAuthLogging() {
  if (typeof originalUseMultiFileAuthState !== 'function') return;

  baileys.useMultiFileAuthState = async function consoleAuthState(folder, ...args) {
    emit('AUTH', `Loading session state from ${folder}`);
    const result = await originalUseMultiFileAuthState.call(this, folder, ...args);
    const registered = !!result?.state?.creds?.registered;
    emit('AUTH', registered ? 'Existing WhatsApp credentials found.' : 'No registered WhatsApp credentials found; pairing is required.');

    const originalSaveCreds = result.saveCreds;
    if (typeof originalSaveCreds === 'function') {
      result.saveCreds = async (...saveArgs) => {
        await originalSaveCreds(...saveArgs);
        const now = Date.now();
        if (now - lastCredLogAt >= 30_000) {
          lastCredLogAt = now;
          emit('AUTH', 'WhatsApp credentials/session state saved.');
        }
      };
    }
    return result;
  };
}

function installSocketLogging() {
  if (typeof originalMakeWASocket !== 'function') return;

  baileys.default = function consoleMakeWASocket(...args) {
    emit('WA', 'Creating WhatsApp socket…');
    const socket = originalMakeWASocket(...args);
    if (!socket) return socket;

    const originalRequestPairingCode = socket.requestPairingCode?.bind(socket);
    if (typeof originalRequestPairingCode === 'function') {
      socket.requestPairingCode = async (phoneNumber) => {
        const number = validNumber(phoneNumber);
        pairingAttempt += 1;
        if (!number) throw new Error('Enter a valid international WhatsApp number (8–15 digits, country code included).');

        emit('PAIR', `Requesting pairing code (attempt ${pairingAttempt}) for +${number}`);
        try {
          // Let the initial WA handshake settle before the pairing request.
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const code = await originalRequestPairingCode(number);
          const display = normalizePairCode(code);
          emit('PAIR', `CODE: ${display || '(empty response)'}`);
          emit('PAIR', 'On WhatsApp: Linked devices → Link a device → Link with phone number instead.');
          return code;
        } catch (error) {
          emit('PAIR', `FAILED: ${error?.message || error}`);
          throw error;
        }
      };
    }

    emit('WA', 'Socket created; waiting for WhatsApp authentication…');
    return socket;
  };
}

installConsole();
installAuthLogging();
installSocketLogging();

module.exports = {
  cleanNumber,
  validNumber,
  normalizePairCode,
  installConsole,
};
