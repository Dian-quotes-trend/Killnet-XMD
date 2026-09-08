// Killnet XMD — Phase 0A command parser
// Syntax only: no permissions, group logic, Baileys calls, or feature behavior.

function parseCommand(text, prefix = '.') {
  const input = String(text || '').trim();
  const commandPrefix = String(prefix || '.');

  if (!input.startsWith(commandPrefix)) return null;

  const body = input.slice(commandPrefix.length).trim();
  if (!body) return null;

  const parts = body.split(/\s+/);
  const command = parts.shift().toLowerCase();

  return {
    command,
    args: parts,
    text: parts.join(' '),
  };
}

module.exports = { parseCommand };
