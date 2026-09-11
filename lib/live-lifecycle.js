'use strict';

const { EventDispatcher } = require('./event-dispatcher');
const { createAutomationConfigStore } = require('./automation-config');
const { createAutomationModules } = require('./automation-modules');
const { createLocalJsonDatabase } = require('./local-json-db');
const { createLiveModeration } = require('./live-moderation');
const { request: requestUserApi } = require('./user-api-provider');
const { buildClearChatPlan, clearChat } = require('./chat-cleanup-service');
const { buildGroupStatusPayload, buildGroupStatusRequest } = require('./group-status-service');
const { createPhase6Boundary, sessionLifecycleState } = require('./phase6-lifecycle');

async function configuredChatbotResponder({ text }) {
  try {
    const result = await requestUserApi('chatbot', text);
    const data = result?.data;
    if (typeof data === 'string') return data.trim();
    if (!data || typeof data !== 'object') return '';
    const candidates = [
      data.reply, data.response, data.answer, data.message, data.text,
      data.result?.reply, data.result?.response, data.result?.answer, data.result?.message, data.result?.text,
      data.data?.reply, data.data?.response, data.data?.answer, data.data?.message, data.data?.text,
    ];
    return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim();
  } catch (_) {
    // Chatbot is optional. A missing/broken provider must not break the main event loop.
    return '';
  }
}

function createLiveLifecycle({ db, dbPath, pick, emojis, onError, isStable, chatbotResponder } = {}) {
  const database = db || createLocalJsonDatabase(dbPath);
  const config = createAutomationConfigStore({ db: database });
  const modules = createAutomationModules({
    config,
    pick,
    emojis,
    chatbotResponder: chatbotResponder || configuredChatbotResponder,
  });
  const moderation = createLiveModeration({
    db: database,
    getGroups: async () => (await config.get()).groups,
    onError,
  });
  const dispatcher = new EventDispatcher({ onError });
  let lifecycle = { connected: false, reconnecting: false, credentialsReady: false };

  const gateStable = () => sessionLifecycleState(lifecycle).stable && (typeof isStable === 'function' ? Boolean(isStable()) : true);
  const phase6 = createPhase6Boundary({ lifecycle: gateStable });

  dispatcher.on('messages.upsert', async ({ sock, messages = [] }) => {
    for (const message of messages) {
      const remoteJid = message?.key?.remoteJid || '';
      const isStatus = remoteJid === 'status@broadcast';
      if (isStatus) {
        await modules.status(sock, message);
        continue;
      }
      await modules.autoread(sock, message);
      await modules.typingOrRecording(sock, message);
      await modules.autoreact(sock, message);
      await modules.presence(sock, message);
      await modules.autoreply(sock, message);
      await modules.chatbot(sock, message);
      await moderation.processMessage(sock, message);
    }
  });

  dispatcher.on('messages.update', async (payload) => payload);
  dispatcher.on('call', async ({ sock, calls = [] }) => modules.anticall(sock, calls));
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
    moderation,
    cleanup: { buildPlan: buildClearChatPlan, clear: clearChat },
    status: { buildPayload: buildGroupStatusPayload, buildRequest: buildGroupStatusRequest },
    dispatcher,
    phase6,
    state(options) { return options && typeof options === 'object' ? sessionLifecycleState(options) : sessionLifecycleState(lifecycle); },
    async emit(event, payload, meta) { return dispatcher.emit(event, payload, meta); },
    attach(sock) {
      if (!sock?.ev?.on) throw new TypeError('A Baileys socket event emitter is required.');
      if (sock.__killnetLifecycleAttached) return sock;
      sock.__killnetLifecycleAttached = true;
      sock.ev.on('messages.upsert', (payload) => dispatcher.emit('messages.upsert', { sock, ...payload }));
      sock.ev.on('messages.update', (updates) => dispatcher.emit('messages.update', { sock, updates }));
      sock.ev.on('call', (calls) => dispatcher.emit('call', { sock, calls }));
      sock.ev.on('connection.update', (payload) => dispatcher.emit('connection.update', payload));
      return sock;
    },
  };
}

module.exports = { createLiveLifecycle, configuredChatbotResponder };
