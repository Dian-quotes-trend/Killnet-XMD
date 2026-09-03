const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');

function normalizeJid(to) {
  const cleaned = String(to || '').trim();
  if (!cleaned) return null;
  if (cleaned.includes('@')) return cleaned;
  const digits = cleaned.replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function startAPI(state, restartBot) {
  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Expose the socket server so the bot runtime can broadcast lifecycle,
  // pairing and message events in real time (see emitWs in index.js).
  state.io = io;

  const snapshot = () =>
    (typeof state.botSnapshot === 'function'
      ? state.botSnapshot()
      : {
          status: state.connectionStatus,
          qr: state.qr,
          pairingCode: state.pairingCode,
          user: state.user ? { id: state.user.id, name: state.user.name } : null,
          startTime: state.startTime,
          messageCount: state.messageLogs.length,
          botName: config.botName,
        });

  const pair = (phone, source) =>
    typeof state.requestPairing === 'function'
      ? state.requestPairing(phone, source)
      : Promise.resolve({ ok: false, error: 'Pairing not available' });

  const live = () => (typeof state.isSocketLive === 'function' ? state.isSocketLive() : state.connectionStatus === 'connected');

  async function sendText(to, message) {
    const jid = normalizeJid(to);
    if (!jid) return { ok: false, error: 'Invalid recipient' };
    if (!message) return { ok: false, error: 'Message required' };
    if (!live()) return { ok: false, error: 'Bot not connected' };
    try {
      await state.sock.sendMessage(jid, { text: message });
      io.emit('message-sent', { to: jid, message, at: new Date().toISOString() });
      return { ok: true, jid };
    } catch (err) {
      io.emit('message-error', { to: jid, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  // ── REST endpoints ──

  app.get('/api/status', (req, res) => res.json(snapshot()));

  app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    res.json({
      total: state.messageLogs.length,
      logs: state.messageLogs.slice(offset, offset + limit),
    });
  });

  // Pair via phone number (single entrypoint, no bot restart needed)
  app.post('/api/pair', async (req, res) => {
    const result = await pair(req.body?.phoneNumber, 'rest');
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true, code: result.code || null, pending: !!result.pending });
  });

  // Disconnect
  app.post('/api/disconnect', (req, res) => {
    if (!state.sock) return res.status(400).json({ error: 'No active connection' });
    state.sock.logout().catch(() => {});
    state.connectionStatus = 'disconnected';
    state.user = null;
    state.qr = null;
    state.pairingCode = null;
    io.emit('bot-status', snapshot());
    res.json({ success: true });
  });

  // Send message
  app.post('/api/send', async (req, res) => {
    const result = await sendText(req.body?.to, req.body?.message);
    if (!result.ok) {
      const code = result.error === 'Bot not connected' ? 400 : 400;
      return res.status(code).json({ error: result.error });
    }
    res.json({ success: true });
  });

  // ── Settings API ──

  app.get('/api/settings', (req, res) => res.json(state.settings));

  app.put('/api/settings', (req, res) => {
    const updates = req.body || {};
    if (updates.prefix !== undefined) state.settings.prefix = updates.prefix;
    if (updates.ownerNumber !== undefined) state.settings.ownerNumber = updates.ownerNumber;
    if (updates.autoReply !== undefined) state.settings.autoReply = { ...state.settings.autoReply, ...updates.autoReply };
    if (updates.autoRead !== undefined) state.settings.autoRead = updates.autoRead;
    if (updates.antiDelete !== undefined) state.settings.antiDelete = updates.antiDelete;
    if (updates.antiCall !== undefined) state.settings.antiCall = { ...state.settings.antiCall, ...updates.antiCall };
    if (updates.autoStatusView !== undefined) state.settings.autoStatusView = updates.autoStatusView;
    if (updates.goodbye !== undefined) state.settings.goodbye = { ...state.settings.goodbye, ...updates.goodbye };
    io.emit('settings-updated', state.settings);
    res.json({ success: true, settings: state.settings });
  });

  // ── Socket.IO: live pairing + sending channel ──
  io.on('connection', (socket) => {
    console.log('📊 Dashboard websocket connected');
    socket.emit('bot-status', snapshot());
    socket.emit('settings-updated', state.settings);

    socket.on('request-status', () => socket.emit('bot-status', snapshot()));

    socket.on('request-pair', async (payload, ack) => {
      const phone = typeof payload === 'string' ? payload : payload?.phoneNumber;
      const result = await pair(phone, 'websocket');
      if (typeof ack === 'function') ack(result);
    });

    socket.on('send-message', async (payload, ack) => {
      const result = await sendText(payload?.to, payload?.message);
      if (typeof ack === 'function') ack(result);
    });

    socket.on('restart-bot', (payload, ack) => {
      try { restartBot && restartBot(); } catch {}
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('disconnect', () => console.log('📊 Dashboard websocket disconnected'));
  });

  server.listen(config.apiPort, () => {
    console.log(`🌐 API + WebSocket running on port ${config.apiPort}`);
  });

  return io;
}

module.exports = { startAPI, normalizeJid };
