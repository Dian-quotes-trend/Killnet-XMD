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

function normalizeCapabilities(values) {
  const list = Array.isArray(values) ? values : values instanceof Set ? [...values] : [];
  return new Set(list.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean));
}

function capabilitiesFromContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return new Set();
  if (ctx.capabilities) return normalizeCapabilities(ctx.capabilities);

  const caps = new Set([CAPABILITIES.PUBLIC]);
  if (ctx.isMember !== false) caps.add(CAPABILITIES.MEMBER);
  if (ctx.isGroupAdmin === true) caps.add(CAPABILITIES.GROUP_ADMIN);
  if (ctx.isBotAdmin === true) caps.add(CAPABILITIES.BOT_ADMIN);
  if (ctx.isOwner === true) caps.add(CAPABILITIES.OWNER);
  if (ctx.isMasterSudo === true) caps.add(CAPABILITIES.MASTER_SUDO);
  return caps;
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

  // PUBLIC is the universal baseline capability. It is never treated as a
  // privileged role and never grants access to a privileged requirement.
  if (required.includes(CAPABILITIES.PUBLIC)) return { allowed: true, required, available };

  // OWNER and MASTER_SUDO are equivalent elevated routes for commands that
  // explicitly request both as alternatives (legacy ownerOnly compatibility).
  const alternatives = required.includes(CAPABILITIES.OWNER) || required.includes(CAPABILITIES.MASTER_SUDO)
    ? required.filter((cap) => cap === CAPABILITIES.OWNER || cap === CAPABILITIES.MASTER_SUDO)
    : [];
  if (alternatives.length && alternatives.some((cap) => available.has(cap))) {
    return { allowed: true, required, available };
  }

  // Other capability lists are fail-closed and require every declared
  // capability. This makes multi-capability commands explicit and auditable.
  if (!alternatives.length && required.every((cap) => available.has(cap))) {
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
  normalizeCapabilities,
  capabilitiesFromContext,
  requiredCapabilities,
  authorize,
};
