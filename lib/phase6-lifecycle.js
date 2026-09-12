'use strict';

const STATUS_JID = 'status@broadcast';
const STATUS_ACTIONS = new Set(['view', 'like', 'save', 'download', 'togroupstatus']);

function assertLifecycleStable(stable) {
  if (stable !== true) {
    const error = new Error('Phase 6 lifecycle gate is closed until Baileys 7.x RC stability is verified.');
    error.code = 'PHASE6_LIFECYCLE_GATE_CLOSED';
    throw error;
  }
}

function classifyStatusMessage(message) {
  const key = message?.key || {};
  if (key.remoteJid !== STATUS_JID) return { isStatus: false, participant: null, id: null };
  return {
    isStatus: true,
    participant: key.participant || key.participantAlt || null,
    id: key.id || null,
  };
}

function buildStatusKey({ id, participant }) {
  if (!id || !participant) return null;
  return { remoteJid: STATUS_JID, id, fromMe: false, participant };
}

function buildStatusAction(action, target) {
  if (!STATUS_ACTIONS.has(action)) throw new Error(`Unsupported status action: ${action}`);
  if (!target) throw new Error('A status target is required.');
  return { action, target };
}

function sessionLifecycleState({ connected = false, reconnecting = false, credentialsReady = false } = {}) {
  const state = {
    connected: Boolean(connected),
    reconnecting: Boolean(reconnecting),
    credentialsReady: Boolean(credentialsReady),
  };
  return { ...state, stable: state.connected && state.credentialsReady && !state.reconnecting };
}

function applySocketLifecycleState(sock, state) {
  if (!sock || typeof sock !== 'object') return state;
  const normalized = sessionLifecycleState(state);
  sock.__killnetSessionState = normalized;
  sock.__killnetPhase6Ready = normalized.stable === true;
  return normalized;
}

function createPhase6Boundary({ lifecycle = () => false } = {}) {
  const ready = () => Boolean(lifecycle());
  return {
    assertReady() { assertLifecycleStable(ready()); },
    statusAction(action, target) {
      assertLifecycleStable(ready());
      return buildStatusAction(action, target);
    },
  };
}

module.exports = {
  STATUS_JID,
  assertLifecycleStable,
  classifyStatusMessage,
  buildStatusKey,
  buildStatusAction,
  sessionLifecycleState,
  applySocketLifecycleState,
  createPhase6Boundary,
};
