// Killnet XMD — Phase 0B command registry
// Registry only: no Baileys, permissions, persistence, or feature behavior.

class CommandRegistry {
  constructor() {
    this.commands = new Map();
    this.aliases = new Map();
  }

  register(command) {
    if (!command || typeof command !== 'object') throw new TypeError('Command definition is required');
    const name = String(command.name || '').trim().toLowerCase();
    if (!name) throw new TypeError('Command name is required');
    if (typeof command.handler !== 'function') throw new TypeError(`Handler required for ${name}`);
    if (this.commands.has(name) || this.aliases.has(name)) throw new Error(`Command already registered: ${name}`);

    const normalized = {
      name,
      description: String(command.description || ''),
      category: String(command.category || 'GENERAL').toUpperCase(),
      handler: command.handler,
      aliases: Array.isArray(command.aliases) ? command.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean) : [],
      permissions: Array.isArray(command.permissions) ? [...command.permissions] : [],
      groupOnly: Boolean(command.groupOnly),
      ownerOnly: Boolean(command.ownerOnly),
    };

    this.commands.set(name, normalized);
    for (const alias of normalized.aliases) this.registerAlias(alias, name);
    return normalized;
  }

  registerAlias(alias, target) {
    const aliasName = String(alias || '').trim().toLowerCase();
    const targetName = String(target || '').trim().toLowerCase();
    if (!aliasName || !targetName) throw new TypeError('Alias and target are required');
    if (!this.commands.has(targetName)) throw new Error(`Cannot alias unknown command: ${targetName}`);
    if (this.commands.has(aliasName) || this.aliases.has(aliasName)) throw new Error(`Command already registered: ${aliasName}`);
    this.aliases.set(aliasName, targetName);
    return targetName;
  }

  resolve(name) {
    const key = String(name || '').trim().toLowerCase();
    if (this.commands.has(key)) return this.commands.get(key);
    const target = this.aliases.get(key);
    return target ? this.commands.get(target) : undefined;
  }

  has(name) { return Boolean(this.resolve(name)); }

  list(category) {
    const commands = [...this.commands.values()];
    if (category == null) return commands;
    const wanted = String(category).trim().toUpperCase();
    return commands.filter((command) => command.category === wanted);
  }

  names() { return [...this.commands.keys()]; }
}

module.exports = { CommandRegistry };