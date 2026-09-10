'use strict';

// Non-invasive transport hook: preserve index.js and the existing Baileys
// connection/auth/reconnect implementation while attaching the modular
// lifecycle dispatcher to every newly-created socket.
const Module = require('module');
const originalLoad = Module._load;
let installed = false;

if (!installed) {
  installed = true;
  Module._load = function patchedLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== '@whiskeysockets/baileys' || typeof loaded?.default !== 'function' || loaded.default.__killnetLifecycleWrapped) return loaded;

    const makeWASocket = loaded.default;
    const { createLiveLifecycle } = require('./live-lifecycle');
    const wrapped = function killnetLifecycleSocket(...args) {
      const sock = makeWASocket(...args);
      try {
        const lifecycle = createLiveLifecycle({
          dbPath: './data/database.json',
          pick: (items) => items[Math.floor(Math.random() * items.length)],
          emojis: ['❤️', '🔥', '💯', '✨', '👍'],
          onError: (error) => console.error(`❌ Lifecycle error: ${error.message || error}`),
        });
        lifecycle.attach(sock);
        global.__killnetLifecycle = lifecycle;
      } catch (error) {
        console.error(`❌ Lifecycle initialization failed: ${error.message || error}`);
      }
      return sock;
    };
    Object.assign(wrapped, makeWASocket);
    wrapped.__killnetLifecycleWrapped = true;
    return { ...loaded, default: wrapped };
  };
}
