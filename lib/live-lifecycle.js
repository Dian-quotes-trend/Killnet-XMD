'use strict';

const { EventDispatcher } = require('./event-dispatcher');
const { createAutomationConfigStore } = require('./automation-config');
const { createAutomationModules } = require('./automation-modules');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createPhase6Boundary, classifyStatusMessage, sessionLifecycleState } = require('./phase6-lifecycle');

/**
 * Runtime lifecycle bridge. It attaches to the existing Baileys emitter and
 * never replaces the connection/auth/reconnect layer. Phase 4 handlers are
 * event driven; Phase 6 actions remain explicitly gated by stability.
 */
function createLiveLifecycle({ db, dbPath, pick, emojis, onError, getSettings, isStable } = {}) {
  const database = db || createLocalJsonDatabase(dbPath);
  const config = createAutomationConfigStore({ db: database });
  const modules = createAutomationModules({ config, pick, emojis });
  const dispatcher = new EventDispatcher({ onError });
  let lifecycle = { connected: false, reconnecting: false, credentialsReady: false };
  let lastLegacySettings = '';

  const syncLegacySettings = async () => {
    if (typeof getSettings !== 'function') return;
    const source = getSettings() || {};
    const snapshot = JSON.stringify({
      autoRead: Boolean(source.autoRead),
      presence: source.presenceMode !== 'off',
      autoReact: Boolean(source.autoReact),
      autoStatusView: Boolean(source.autoStatusView),
      autoLikeStatus: Boolean(source.autoLikeStatus),
    });
    if (snapshot === lastLegacySettings) return;
    await config.update((current) => ({
      ...current,
      global: {
        ...current.global,
        autoread: Boolean(source.autoRead),
        presence: source.presenceMode !== 'off',
        autoreact: Boolean(source.autoReact),
      },
      status: {
        ...current.status,
        autoview: Boolean(source.autoStatusView),
        autolike: Boolean(source.autoLikeStatus),
      },
    }));
    lastLegacySettings = snapshot;
  };

  const gateStable = () => {
    const transportStable = sessionLifecycleState(lifecycle).stable;
    return transportStable && (typeof isStable === 'function' ? Boolean(isStable()) : true);
  };
  const phase6 = createPhase6Boundary({ lifecycle: gateStable });

  dispatcher.on('messages.upsert', async ({ sock, messages = [] }) => {
    await syncLegacySettings();
    for (const message of messages) {
      await modules.autoread(sock, message);
      await modules.autoreact(sock, message);
      await modules.presence(sock, message, 'available');
      if (message?.key?.remoteJid === 'status@broadcast') {
        await dispatcher.emit('status.message', { sock, message });
      }
    }
  });

  dispatcher.on('status.message', async ({ message }) => classifyStatusMessage(message));
  dispatcher.on('messages.update', async (payload) => payload);
  dispatcher.on('call', async (payload) => payload);
  dispatcher.on('connection.update', async ({ connection, credsReady } = {}) => {
    if (connection === 'connecting') lifecycle = { ...lifecycle, connected: false, reconnecting: true };
    if (connection === 'open') lifecycle = { ...lifecycle, connected: true, reconnecting: false, credentialsReady: Boolean(credsReady ?? true) };
    if (connection === 'close') lifecycle = { ...lifecycle, connected: false, reconnecting: true };
    return sessionLifecycleState(lifecycle);
  });

  return {
    database,
    config,
    modules,
    dispatcher,
    phase6,
    state(options) { return options && typeof options === 'object' ? sessionLifecycleState(options) : sessionLifecycleState(lifecycle); },
    async emit(event, payload, meta) { return dispatcher.emit(event, payload, meta); },
    attach(sock) {
      if (!sock?.ev?.on) throw new TypeError('A Baileys socket event emitter is required.');
      sock.ev.on('messages.upsert', (payload) => dispatcher.emit('messages.upsert', { sock, ...payload }));
      sock.ev.on('messages.update', (updates) => dispatcher.emit('messages.update', { sock, updates }));
      sock.ev.on('call', (calls) => dispatcher.emit('call', { sock, calls }));
      sock.ev.on('connection.update', (payload) => dispatcher.emit('connection.update', payload));
      return sock;
    },
  };
}

module.exports = { createLiveLifecycle };