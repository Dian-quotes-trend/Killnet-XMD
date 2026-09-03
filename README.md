# W-MD WhatsApp Bot

## Quick Start

### 1. Install dependencies
```bash
cd bot-host
npm install
```

### 2. Configure
Edit `config.js` or create a `.env` file (see `.env.example`).

### 3. Run the bot

**Option A — Fresh start (pairing code):**
```bash
npm start
```
You'll be prompted to enter your WhatsApp number. A pairing code will be generated.
Open WhatsApp → Linked Devices → Link a Device → Link with phone number → Enter the code.

**Option B — Fresh start (QR code):**
Set `PAIR_MODE=qr` (or `both` for code-first with QR fallback) in `.env`, your host panel, or `config.js` → `HARDCODED`, then:
```bash
npm start
```
Scan the QR code with WhatsApp.

**Option C — Existing session (creds.json):**
Place your `creds.json` file inside the `session/` folder:
```
bot-host/
  session/
    creds.json
```
Then run `npm start`. It will auto-connect using the saved credentials.

### 4. Dashboard
The bot exposes an API on port 3001 (configurable).
Set your dashboard URL in the Lovable app to point to your bot server.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Bot connection status |
| GET | `/api/logs?limit=50&offset=0` | Message logs |
| POST | `/api/pair` | Start pairing `{ phoneNumber: "..." }` |
| POST | `/api/disconnect` | Disconnect bot |
| POST | `/api/send` | Send message `{ to: "...", message: "..." }` |

## WebSocket Events

Connect via Socket.IO to receive real-time updates:
- `bot-status` — Connection status, QR, pairing code, user info

## Hosting on bot-host.net

1. Upload the entire `bot-host` folder
2. Set `PORT` environment variable if needed
3. Set `DASHBOARD_USER_ID` (from dashboard → Settings → Dashboard ID) — via panel env, a `.env` file, or `config.js` → `HARDCODED`
4. Run `npm install && npm start`
