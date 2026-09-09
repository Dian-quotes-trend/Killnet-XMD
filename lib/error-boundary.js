'use strict';

const ERROR_TYPES = Object.freeze({
  COMMAND: 'COMMAND',
  EVENT: 'EVENT',
  AUTOMATION: 'AUTOMATION',
  CONNECTION: 'CONNECTION',
  PERSISTENCE: 'PERSISTENCE',
  INTERNAL: 'INTERNAL',
});

function normalizeType(type) {
  const value = String(type || ERROR_TYPES.INTERNAL).trim().toUpperCase();
  return Object.values(ERROR_TYPES).includes(value) ? value : ERROR_TYPES.INTERNAL;
}

function toError(error) {
  if (error instanceof Error) return error;
  const result = new Error(typeof error === 'string' ? error : 'Unknown error');
  result.cause = error;
  return result;
}

function createErrorBoundary({ logger = console, onError } = {}) {
  async function run(type, operation, fn, context = {}) {
    const errorType = normalizeType(type);
    try {
      return await fn();
    } catch (error) {
      const normalized = toError(error);
      const details = { type: errorType, operation: String(operation || 'unknown'), ...context, error: normalized };
      try {
        if (typeof onError === 'function') await onError(normalized, details);
        else if (typeof logger.error === 'function') logger.error(`Unhandled ${errorType} error in ${details.operation}`, details);
      } catch (_) {
        // Reporting must never create a second failure.
      }
      return { ok: false, error: normalized, type: errorType, operation: details.operation };
    }
  }

  return {
    run,
    command: (operation, fn, context) => run(ERROR_TYPES.COMMAND, operation, fn, context),
    event: (operation, fn, context) => run(ERROR_TYPES.EVENT, operation, fn, context),
    automation: (operation, fn, context) => run(ERROR_TYPES.AUTOMATION, operation, fn, context),
    connection: (operation, fn, context) => run(ERROR_TYPES.CONNECTION, operation, fn, context),
    persistence: (operation, fn, context) => run(ERROR_TYPES.PERSISTENCE, operation, fn, context),
    internal: (operation, fn, context) => run(ERROR_TYPES.INTERNAL, operation, fn, context),
  };
}

module.exports = { ERROR_TYPES, normalizeType, toError, createErrorBoundary };
