# Killnet XMD

A lightweight, production-oriented WhatsApp MD bot built with **Node.js** and **Baileys**. Killnet XMD focuses on a small, reliable feature set instead of a large collection of fragile commands.

> **Important:** This project uses the unofficial Baileys WhatsApp Web API. Use it responsibly and comply with WhatsApp's Terms of Service. Do not use it for spam, bulk unsolicited messaging, stalking, or other abusive automation.

## ✨ Features

### Automation
- ✅ Auto-read incoming messages
- ✅ Auto-typing presence
- ✅ Auto-recording presence
- ✅ Auto-reply with a custom message
- ✅ Auto-view WhatsApp Status
- ✅ Auto-react to messages with configurable emojis
- ✅ Auto-react to Status updates with configurable emojis
- ✅ Presence modes: `online`, `lastseen`, `typing`, `recording`, `off`
- ✅ Anti-call with configurable `decline` mode and custom reply
- ✅ Anti-delete recovery for messages still held in the bot's recent-message cache

### Group tools
- ✅ `.tagall`
- ✅ `.hidetag`
- ✅ `.antilink`
- ✅ `.delete` / `.del`
- ✅ Owner-only group moderation helpers

### Utility
- ✅ `.ping`
- ✅ `.alive`
- ✅ `.menu` / `.help`
- ✅ `.info`
- ✅ `.owner`
- ✅ `.settings`
- ✅ `.report`
- ✅ Public/private bot mode
- ✅ Configurable command prefix
- ✅ Persistent JSON settings

### Authentication
- ✅ WhatsApp pairing-code login
- ✅ QR-code login
- ✅ Existing session reuse
- ✅ Automatic credential persistence
- ✅ Automatic reconnect for transient disconnects
- ✅ Explicit handling of logout and restart-required disconnects
- ✅ LID/phone-number aware JID handling

## 📦 Requirements

- **Node.js 20 or newer**
- A WhatsApp account that can link another device
- A server/VPS, panel host, or local machine capable of running a persistent Node.js process

Baileys currently publishes `7.0.0-rc14` as the npm `latest` release, and Killnet XMD is pinned to that version so deployments do not silently change behavior after a fresh install. citehttps://www.npmjs.com/package/%40whiskeysockets/baileys

## 🚀 Installation

```bash
git clone https://github.com/Dian-quotes-trend/Killnet-XMD.git
cd Killnet-XMD
npm install
```

Validate the source before starting:

```bash
npm test
```

Start the bot:

```bash
npm start
```

For development:

```bash
npm run dev
```

## 🔐 Pairing

### Pairing code

The default mode is `code`.

1. Start the bot with `npm start`.
2. Enter the WhatsApp number using the international country code and **digits only**.
3. Open WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead**.
4. Enter the displayed pairing code.

Example number format:

```text
256700000000
```

Do **not** enter `+`, spaces, or dashes.

### QR mode

Set:

```env
PAIR_MODE=qr
```

Then start the bot and scan the QR shown in the terminal.

### Both

```env
PAIR_MODE=both
```

This enables pairing-code login while also allowing QR output when WhatsApp supplies a QR event.

## ⚙️ Configuration

Copy `.env.example` to `.env` and change the values for your deployment.

```env
BOT_NAME=Killnet XMD
OWNER_NUMBER=256700000000
TIMEZONE=Africa/Kampala
PACK_NAME=Killnet XMD
AUTHOR=Diansybextech
PAIR_MODE=code
QUIET_LOGS=true
BAILEYS_LOG_LEVEL=silent
PORT=3001
```

### Important variables

| Variable | Purpose | Example |
|---|---|---|
| `BOT_NAME` | Bot display name | `Killnet XMD` |
| `OWNER_NUMBER` | Owner number, digits only | `256700000000` |
| `PAIR_MODE` | `code`, `qr`, or `both` | `code` |
| `QUIET_LOGS` | Reduce terminal noise | `true` |
| `BAILEYS_LOG_LEVEL` | Baileys logger level | `silent` |
| `PORT` | Retained for hosting compatibility | `3001` |

Never commit `.env` or the `session/` directory.

## 🧭 Command Reference

### General

| Command | Description | Access |
|---|---|---|
| `.ping` | Check response time | Everyone |
| `.alive` | Show bot status | Everyone |
| `.menu` | Show commands | Everyone |
| `.help` | Show commands | Everyone |
| `.owner` | Show owner | Everyone |
| `.info` | Show runtime information | Everyone |
| `.settings` | Show automation state | Owner |

### Automation

| Command | Description |
|---|---|
| `.autoread` | Toggle auto-read |
| `.autotyping` | Toggle auto-typing |
| `.autorecording` | Toggle auto-recording |
| `.autoreply` | Toggle auto-reply; add text to set a custom message |
| `.autostatus` | Toggle automatic Status viewing |
| `.autoreact` | Toggle automatic message reactions |
| `.autoreactstatus` | Toggle Status reactions |
| `.antidelete` | Toggle anti-delete recovery |
| `.anticall` | Toggle anti-call |
| `.anticallmsg <text>` | Change anti-call reply |
| `.presence <mode>` | Set presence mode |

### Groups

| Command | Description |
|---|---|
| `.tagall` | Mention all group members |
| `.hidetag <text>` | Mention all members without displaying the mentions |
| `.antilink` | Toggle link protection for the current group |
| `.delete` / `.del` | Delete a replied message |

### Owner / administration

| Command | Description |
|---|---|
| `.mode public` | Allow normal users to use commands |
| `.mode private` | Restrict commands to owner/self |
| `.setprefix <prefix>` | Change the command prefix |
| `.ban @user` | Add a user to the local ban list |
| `.unban @user` | Remove a user from the local ban list |
| `.report <message>` | Send a report directly to the configured owner |

## 💾 Data and session storage

Runtime state is stored locally:

```text
Killnet-XMD/
├── data/
│   ├── settings.json
│   ├── autoreply.json
│   ├── anticall.json
│   ├── banned.json
│   └── antilink.json
├── session/
│   └── WhatsApp authentication files
├── config.js
├── index.js
└── package.json
```

Both `data/` and `session/` are ignored by Git.

**Back up `session/` carefully** if you want to preserve a linked account. Never publish it.

## 🔄 Reconnection behavior

Killnet XMD distinguishes normal connection restarts from permanent logout conditions:

- `restartRequired` / `515` → recreate the socket
- transient connection failures → reconnect after a short delay
- `connectionReplaced` → wait longer before reconnecting
- `loggedOut` / `403` → stop and require a fresh pairing

This avoids treating every disconnect as a fatal error or blindly reusing a bad session.

## 🧪 Validation

The repository includes a lightweight CI check:

```bash
npm test
```

It validates the JavaScript syntax for the main runtime, configuration, and session helper. GitHub Actions runs the same check on Node.js 20 for pushes and pull requests.

A successful syntax check does **not** replace a real WhatsApp integration test. Pairing, message delivery, Status events, calls, and group administration require a live WhatsApp account.

## 🏗️ Project structure

```text
.
├── .github/workflows/ci.yml   # Node 20 CI validation
├── .env.example                # Deployment template
├── config.js                   # Environment/config loader
├── index.js                    # Bot runtime and command handlers
├── lib/session.js              # Session validation/quarantine helper
├── package.json                # Dependencies and scripts
├── BAILEYS_REVIEW.md           # Baileys compatibility notes
└── README.md                   # Documentation
```

## 🛡️ Security notes

- Keep `session/` private.
- Keep `.env` private.
- Use a dedicated WhatsApp number for automation where appropriate.
- Do not expose authentication files through a public web server.
- Set a real `OWNER_NUMBER`; owner-only commands depend on it.
- Do not run multiple bot instances against the same session.

## 📚 Baileys compatibility

Killnet XMD targets Baileys `7.0.0-rc14`. Baileys 7 contains breaking changes compared with the 6.x line, so the dependency is intentionally pinned rather than using a loose version range. The project also uses Node.js 20+, matching the current Baileys quickstart requirement. citehttps://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx

## 📄 License

See [LICENSE](LICENSE).

## 👨‍💻 Credits

**Killnet XMD** by **Diansybextech**.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys).
