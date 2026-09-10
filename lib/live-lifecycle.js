'use strict';

const { EventDispatcher } = require('./event-dispatcher');
const { createAutomationConfigStore } = require('./automation-config');
const { createAutomationModules } = require('./automation-modules');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createPhase6Boundary, classifyStatusMessage, sessionLifecycleState } = require('./phase6-lifecycle');

/**
 * Live lifecycle bridge. It owns event-driven Phase 4 automation and exposes
 * the Phase 5/6 boundaries without replacing the existing Baileys transport.
 * Phase 6 transport actions stay gated until the caller reports stability.
 */
function createLiveLifecycle({ db, dbPath, pick, emojis, isStable = () => false, onError } = {}) {
  const database = db || createLocalJsonDatabase(dbPath);
  const config = createAutomationConfigStore({ db: database });
  const modules = createAutomationModules({ config, pick, emojis });
  const dispatcher = new EventDispatcher({ onError });
  const phase6 = createPhase6Boundary({ lifecycle: isStable });

  dispatcher.on('messages.upsert', async ({ sock, messages = [] }) => {
    for (const message of messages) {
      await modules.autoread(sock, message);
      await modules.autoreact(sock, message);
      await modules.presence(sock, message, 'available');
    }
  });

  dispatcher.on('status.message', async ({ message }) => {
    // Classification is always safe; actions remain behind the Phase 6 gate.
    return classifyStatusMessage(message);
  });

  return {
    database,
    config,
    modules,
    dispatcher,
    phase6,
    state(options) { return sessionLifecycleState(options); },
    async emit(event, payload, meta) { return dispatcher.emit(event, payload, meta); },
    attach(sock) {
      if (!sock?.ev?.on) throw new TypeError('A Baileys socket event emitter is required.');
      sock.ev.on('messages.upsert', (payload) => dispatcher.emit('messages.upsert', { sock, ...payload }));
      sock.ev.on('status.message', (message) => dispatcher.emit('status.message', { message }));
      return sock;
    },
  };
}

module.exports = { createLiveLifecycle };
