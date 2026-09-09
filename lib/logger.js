'use strict';

const DEFAULT_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'fatal']);
const SENSITIVE_KEYS = /pass(word)?|token|secret|api[-_]?key|authorization|cookie|session|creds?|private[-_]?key/i;

function normalizeLevel(level) {
  const value = String(level || 'info').trim().toLowerCase();
  return DEFAULT_LEVELS.includes(value) ? value : 'info';
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitize(item, seen);
  }
  return output;
}

function createLogger({ sink = console, minLevel = process.env.LOG_LEVEL || 'info', context = {} } = {}) {
  const threshold = DEFAULT_LEVELS.indexOf(normalizeLevel(minLevel));
  const baseContext = sanitize(context);

  function write(level, message, data) {
    const index = DEFAULT_LEVELS.indexOf(level);
    if (index < threshold) return;
    const payload = {
      time: new Date().toISOString(),
      level,
      ...baseContext,
      ...(data === undefined ? {} : { data: sanitize(data) }),
    };
    const fn = typeof sink[level] === 'function' ? sink[level].bind(sink) : sink.log.bind(sink);
    fn(typeof message === 'string' ? message : String(message), payload);
  }

  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
    fatal: (message, data) => write('fatal', message, data),
    child: (childContext) => createLogger({ sink, minLevel, context: { ...baseContext, ...childContext } }),
  };
}

module.exports = { DEFAULT_LEVELS, normalizeLevel, sanitize, createLogger };
