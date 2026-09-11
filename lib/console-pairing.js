'use strict';

/**
 * Safe console/boot logger.
 *
 * This module deliberately does NOT modify Baileys exports, auth helpers,
 * sockets, or console methods. The real WhatsApp lifecycle remains owned by
 * index.js. It only provides small helpers for startup/error reporting and
 * installs process-level crash logging.
 */

const startedAt = Date.now();

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function emit(level, message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  const line = `[${stamp()}] [${level}] ${text}`;
  if (level === 'ERROR' || level === 'FATAL') return process.stderr.write(`${line}\n`);
  return process.stdout.write(`${line}\n`);
}

function boot(message) { return emit('BOOT', message); }
function auth(message) { return emit('AUTH', message); }
function wa(message) { return emit('WA', message); }
function pair(message) { return emit('PAIR', message); }
function ready(message) { return emit('READY', message); }
function warn(message) { return emit('WARN', message); }
function error(message) { return emit('ERROR', message); }

function cleanNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function validNumber(value) {
  const number = cleanNumber(value);
  return number.length >= 8 && number.length <= 15 ? number : '';
}

function normalizePairCode(code) {
  const raw = String(code || '').replace(/\s+/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function installCrashLogging() {
  if (global.__KILLNET_CONSOLE_LOGGER__) return;
  global.__KILLNET_CONSOLE_LOGGER__ = true;

  process.on('uncaughtException', (err) => {
    emit('FATAL', `Uncaught exception: ${err?.stack || err?.message || err}`);
  });

  process.on('unhandledRejection', (reason) => {
    emit('ERROR', `Unhandled rejection: ${reason?.stack || reason?.message || reason}`);
  });

  process.on('exit', (code) => {
    if (code !== 0) emit('FATAL', `Process exited with code ${code}.`);
  });
}

// Must run before index.js loads its legacy settings files. This is a data
// migration only; no Baileys or socket APIs are patched.
try { require('./phase4-legacy-migration'); } catch (error) { emit('ERROR', `Phase 4 migration failed: ${error?.message || error}`); }

installCrashLogging();

module.exports = {
  startedAt,
  stamp,
  emit,
  boot,
  auth,
  wa,
  pair,
  ready,
  warn,
  error,
  cleanNumber,
  validNumber,
  normalizePairCode,
};
