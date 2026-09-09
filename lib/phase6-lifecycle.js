'use strict';

// Phase 6 lifecycle boundary. These helpers deliberately do not activate
// status/session operations; callers must prove the Baileys 7.x RC lifecycle
// is stable before wiring transport actions here.

const STATUS_JID = 'status@broadcast';

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
  const allowed = new Set(['view', 'like', 'save', 'togroupstatus']);
  if (!allowed.has(action)) throw new Error(`Unsupported status action: ${action}`);
  if (!target) throw new Error('A status target is required.');
  return { action, target };
}

function sessionLifecycleState({ connected = false, reconnecting = false, credentialsReady = false } = {}) {
  return {
    connected: Boolean(connected),
    reconnecting: Boolean(reconnecting),
    credentialsReady: Boolean(credentialsReady),
    stable: Boolean(connected && credentialsReady && !reconnecting),
  };
}

function createPhase6Boundary({ lifecycle = () => false } = {}) {
  return {
    assertReady() { assertLifecycleStable(Boolean(lifecycle())); },
    statusAction(action, target) { assertLifecycleStable(Boolean(lifecycle())); return buildStatusAction(action, target); },
  };
}

module.exports = { STATUS_JID, assertLifecycleStable, classifyStatusMessage, buildStatusKey, buildStatusAction, sessionLifecycleState, createPhase6Boundary };
