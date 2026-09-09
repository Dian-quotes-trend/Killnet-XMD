// Killnet XMD — Phase 0D owner / master-sudo access storage contract
// Persistence is deliberately injected. Phase 0E will provide the local JSON
// database adapter, so this module does not duplicate persistence logic.

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNumber(value) {
  const number = digits(value);
  return number || null;
}

function normalizeState(value = {}) {
  return {
    ownerNumber: normalizeNumber(value.ownerNumber),
    masterSudo: normalizeNumber(value.masterSudo),
  };
}

function assertAdapter(adapter) {
  if (!adapter || typeof adapter.get !== 'function' || typeof adapter.set !== 'function') {
    throw new TypeError('Owner/Sudo storage requires an adapter with get() and set()');
  }
}

function createOwnerSudoStore(adapter, defaults = {}) {
  assertAdapter(adapter);
  let state = normalizeState(defaults);
  let loaded = false;

  async function load() {
    const stored = await adapter.get('access.ownerSudo');
    if (stored && typeof stored === 'object') state = normalizeState({ ...state, ...stored });
    loaded = true;
    return { ...state };
  }

  async function ensureLoaded() {
    if (!loaded) await load();
  }

  async function save(next) {
    await ensureLoaded();
    state = normalizeState({ ...state, ...next });
    await adapter.set('access.ownerSudo', { ...state });
    return { ...state };
  }

  async function get() {
    await ensureLoaded();
    return { ...state };
  }

  async function setOwner(value) {
    const ownerNumber = normalizeNumber(value);
    if (!ownerNumber) throw new TypeError('A valid owner number is required');
    return save({ ownerNumber });
  }

  async function setMasterSudo(value) {
    const masterSudo = normalizeNumber(value);
    if (!masterSudo) throw new TypeError('A valid master-sudo number is required');
    return save({ masterSudo });
  }

  async function clearOwner() {
    return save({ ownerNumber: null });
  }

  async function clearMasterSudo() {
    return save({ masterSudo: null });
  }

  function matchesOwner(value) {
    return Boolean(state.ownerNumber && normalizeNumber(value) === state.ownerNumber);
  }

  function matchesMasterSudo(value) {
    return Boolean(state.masterSudo && normalizeNumber(value) === state.masterSudo);
  }

  return {
    load,
    get,
    setOwner,
    setMasterSudo,
    clearOwner,
    clearMasterSudo,
    matchesOwner,
    matchesMasterSudo,
  };
}

module.exports = {
  digits,
  normalizeNumber,
  normalizeState,
  createOwnerSudoStore,
};
