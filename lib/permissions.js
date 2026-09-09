// Killnet XMD — Phase 0C centralized permission/capability system
// Security boundary only. Feature handlers should not implement role checks themselves.

const CAPABILITIES = Object.freeze({
  PUBLIC: 'PUBLIC',
  MEMBER: 'MEMBER',
  GROUP_ADMIN: 'GROUP_ADMIN',
  BOT_ADMIN: 'BOT_ADMIN',
  OWNER: 'OWNER',
  MASTER_SUDO: 'MASTER_SUDO',
});

const PRIVILEGE_INHERITANCE = Object.freeze({
  [CAPABILITIES.MASTER_SUDO]: [CAPABILITIES.OWNER, CAPABILITIES.BOT_ADMIN, CAPABILITIES.GROUP_ADMIN, CAPABILITIES.MEMBER, CAPABILITIES.PUBLIC],
  [CAPABILITIES.OWNER]: [CAPABILITIES.BOT_ADMIN, CAPABILITIES.GROUP_ADMIN, CAPABILITIES.MEMBER, CAPABILITIES.PUBLIC],
  [CAPABILITIES.BOT_ADMIN]: [CAPABILITIES.GROUP_ADMIN, CAPABILITIES.MEMBER, CAPABILITIES.PUBLIC],
  [CAPABILITIES.GROUP_ADMIN]: [CAPABILITIES.MEMBER, CAPABILITIES.PUBLIC],
  [CAPABILITIES.MEMBER]: [CAPABILITIES.PUBLIC],
  [CAPABILITIES.PUBLIC]: [],
});

function normalizeCapabilities(values) {
  const list = Array.isArray(values) ? values : values instanceof Set ? [...values] : [];
  return new Set(list.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean));
}

function expandCapabilities(values) {
  const expanded = normalizeCapabilities(values);
  for (const capability of [...expanded]) {
    for (const inherited of PRIVILEGE_INHERITANCE[capability] || []) expanded.add(inherited);
  }
  return expanded;
}

function capabilitiesFromContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return new Set();
  if (ctx.capabilities) return expandCapabilities(ctx.capabilities);

  const caps = new Set([CAPABILITIES.PUBLIC]);
  if (ctx.isMember !== false) caps.add(CAPABILITIES.MEMBER);
  if (ctx.isGroupAdmin === true) caps.add(CAPABILITIES.GROUP_ADMIN);
  if (ctx.isBotAdmin === true) caps.add(CAPABILITIES.BOT_ADMIN);
  if (ctx.isOwner === true) caps.add(CAPABILITIES.OWNER);
  if (ctx.isMasterSudo === true) caps.add(CAPABILITIES.MASTER_SUDO);
  return expandCapabilities(caps);
}

function requiredCapabilities(command) {
  if (!command || typeof command !== 'object') return [];
  const explicit = Array.isArray(command.permissions)
    ? command.permissions.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (explicit.length) return explicit;
  // Compatibility for legacy registry entries during incremental migration.
  if (command.ownerOnly) return [CAPABILITIES.OWNER, CAPABILITIES.MASTER_SUDO];
  return [CAPABILITIES.PUBLIC];
}

function authorize(ctx, command) {
  const required = requiredCapabilities(command);
  const available = capabilitiesFromContext(ctx);

  if (required.includes(CAPABILITIES.PUBLIC)) return { allowed: true, required, available };

  // OWNER and MASTER_SUDO requirements are alternative elevated routes.
  const elevatedAlternatives = required.filter((cap) => cap === CAPABILITIES.OWNER || cap === CAPABILITIES.MASTER_SUDO);
  if (elevatedAlternatives.length && elevatedAlternatives.some((cap) => available.has(cap))) {
    return { allowed: true, required, available };
  }

  // All other declared capabilities are cumulative requirements.
  if (!elevatedAlternatives.length && required.every((cap) => available.has(cap))) {
    return { allowed: true, required, available };
  }

  return {
    allowed: false,
    required,
    available,
    reason: 'permission-denied',
    missing: required.filter((cap) => !available.has(cap)),
  };
}

module.exports = {
  CAPABILITIES,
  PRIVILEGE_INHERITANCE,
  normalizeCapabilities,
  expandCapabilities,
  capabilitiesFromContext,
  requiredCapabilities,
  authorize,
};
