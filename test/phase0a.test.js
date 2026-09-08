const assert = require('assert');
const { parseCommand } = require('../lib/command-parser');
const { normalizeMessageContext } = require('../lib/message-context');

assert.deepStrictEqual(parseCommand('.kick @123', '.'), {
  command: 'kick',
  args: ['@123'],
  text: '@123',
});

assert.strictEqual(parseCommand('kick @123', '.'), null);
assert.strictEqual(parseCommand('.', '.'), null);
assert.deepStrictEqual(parseCommand('!TAGALL hello world', '!'), {
  command: 'tagall',
  args: ['hello', 'world'],
  text: 'hello world',
});

const raw = {
  key: {
    remoteJid: '12345-678@g.us',
    participant: '256700000001@s.whatsapp.net',
    fromMe: false,
    id: 'ABC123',
  },
  message: {
    extendedTextMessage: {
      text: '.warn @256700000002 spam',
      contextInfo: {
        mentionedJid: ['256700000002@s.whatsapp.net'],
        stanzaId: 'QUOTED1',
        participant: '256700000003@s.whatsapp.net',
      },
    },
  },
};

const ctx = normalizeMessageContext(raw, '.');
assert.strictEqual(ctx.chatId, '12345-678@g.us');
assert.strictEqual(ctx.senderId, '256700000001@s.whatsapp.net');
assert.strictEqual(ctx.isGroup, true);
assert.strictEqual(ctx.command, 'warn');
assert.deepStrictEqual(ctx.args, ['@256700000002', 'spam']);
assert.strictEqual(ctx.quoted.id, 'QUOTED1');
assert.deepStrictEqual(ctx.mentionedJids, ['256700000002@s.whatsapp.net']);
assert.strictEqual(ctx.isFromMe, false);

console.log('Phase 0A tests passed.');
