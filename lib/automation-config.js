'use strict';

const DEFAULT_CONFIG = {
  global: {
    autoread: false,
    autotyping: false,
    autorecording: false,
    autorecordtype: false,
    presence: false,
    autoreact: false,
    chatbot: false,
    antistatus: false,
  },
  groups: {},
  status: { autoview: false, autolike: false, autosave: false },
  chatbot: { global: false, dm: false, group: false, chats: {} },
  autoreply: { enabled: false, message: '' },
  anticall: { enabled: false, mode: 'decline', message: '🚫 Calls are not allowed. Please send a message instead.' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = clone(DEFAULT_CONFIG);
  if (source.global && typeof source.global === 'object') out.global = { ...out.global, ...source.global };
  if (source.status && typeof source.status === 'object') out.status = { ...out.status, ...source.status };
  if (source.chatbot && typeof source.chatbot === 'object') {
    out.chatbot = {
      ...out.chatbot,
      ...source.chatbot,
      chats: source.chatbot.chats && typeof source.chatbot.chats === 'object' ? { ...source.chatbot.chats } : {},
    };
  }
  if (source.autoreply && typeof source.autoreply === 'object') out.autoreply = { ...out.autoreply, ...source.autoreply };
  if (source.anticall && typeof source.anticall === 'object') out.anticall = { ...out.anticall, ...source.anticall };
  if (source.groups && typeof source.groups === 'object') out.groups = clone(source.groups);
  return out;
}

function createAutomationConfigStore({ db, key = 'automation.config' } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.set !== 'function') throw new Error('A database adapter with get/set is required.');
  async function get() { return normalizeConfig(await db.get(key, DEFAULT_CONFIG)); }
  async function set(value) { const config = normalizeConfig(value); await db.set(key, config); return config; }
  async function update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    const config = await get();
    const next = await mutator(config);
    return set(next === undefined ? config : next);
  }
  return { get, set, update };
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, createAutomationConfigStore };
