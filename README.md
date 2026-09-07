# ⚡ Killnet XMD

> A professional, lightweight WhatsApp MD automation bot built with Node.js and Baileys.

**Creator:** Dian Sybex Tech  
**Project:** Killnet XMD  
**Prefix:** `.` by default

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Baileys](https://img.shields.io/badge/Baileys-7.0.0--rc14-25D366)](https://www.npmjs.com/package/@whiskeysockets/baileys)

## ✨ Highlights

- 🔐 Pairing-code and QR authentication
- 🔄 Automatic reconnect handling
- 🛡️ **Master Sudo** with global administrative access
- ⚙️ Auto-read, typing, recording, Status view and reactions
- 💬 Custom auto-reply
- 🗑️ Anti-delete recovery from the local message cache
- 📵 Anti-call protection
- 👥 Tag-all, hidetag and anti-link group tools
- 🚫 Local ban/unban controls
- 🔒 Public/private mode
- 💾 Persistent JSON configuration
- 🧭 Professional categorized command menu

## 👑 Master Sudo

Killnet XMD includes a global master administrator:

```text
256754851585
```

The Master Sudo is checked independently from the normal bot owner. It can use owner/admin commands **even when the bot is in private mode and even when that number is not configured as the bot owner**.

Configure it with:

```env
MASTER_SUDO=256754851585
```

For security, keep the Master Sudo number private and change it if the account is ever compromised.

## 📦 Requirements

- Node.js 20+
- A WhatsApp account that can link a companion device
- A persistent server/VPS/panel or local Node.js environment

Baileys `7.0.0-rc14` is pinned to keep fresh deployments reproducible. Baileys 7 introduces breaking changes compared with 6.x, so avoid casually changing the dependency without testing. See the official package for current release information.

## 🚀 Installation

```bash
git clone https://github.com/Dian-quotes-trend/Killnet-XMD.git
cd Killnet-XMD
npm install
npm test
npm start
```

Development:

```bash
npm run dev
```

## 🔐 Pairing

### Pairing code

Pairing code is the default mode.

1. Start the bot.
2. Enter your WhatsApp number with country code and digits only.
3. Open WhatsApp → Linked devices → Link a device → Link with phone number instead.
4. Enter the displayed code.

Example:

```text
256700000000
```

You can skip the interactive number prompt by setting:

```env
PAIR_NUMBER=256700000000
```

### QR

```env
PAIR_MODE=qr
```

### Both

```env
PAIR_MODE=both
```

Pairing-code requests are made only after the socket reaches the appropriate connection/QR lifecycle event, which is important with current Baileys releases. citeturn1search0turn1search8

## ⚙️ Configuration

Copy `.env.example` to `.env` and edit it:

```env
BOT_NAME=Killnet XMD
OWNER_NUMBER=256700000000
MASTER_SUDO=256754851585
PREFIX=.
TIMEZONE=Africa/Kampala
PACK_NAME=Killnet XMD
AUTHOR=Dian Sybex Tech
PAIR_MODE=code
QUIET_LOGS=true
BAILEYS_LOG_LEVEL=silent
```

Never commit `.env` or `session/`.

## 🧭 Command Menu

### 🧭 General

| Command | Purpose |
|---|---|
| `.menu` / `.help` | Professional command menu |
| `.ping` | Response-time check |
| `.alive` | Bot status and uptime |
| `.info` | Runtime information |
| `.owner` | Owner and Master Sudo information |

### ⚙️ Automation

| Command | Purpose |
|---|---|
| `.autoread` | Toggle auto-read |
| `.autotyping` | Toggle typing presence |
| `.autorecording` | Toggle recording presence |
| `.autoreply` | Toggle/set custom auto-reply |
| `.autostatus` | Toggle Status viewing |
| `.autoreact` | Toggle message reactions |
| `.autoreactstatus` | Toggle Status reactions |
| `.antidelete` | Toggle deleted-message recovery |
| `.anticall` | Toggle anti-call |
| `.anticallmsg <text>` | Change anti-call reply |
| `.presence <mode>` | `online`, `lastseen`, `typing`, `recording`, `off` |

### 👥 Groups

| Command | Purpose |
|---|---|
| `.tagall` | Mention all group members |
| `.hidetag` | Mention all members without visible tags |
| `.antilink` | Toggle group link protection |
| `.delete` / `.del` | Delete a replied message |

### 🛡️ Admin

| Command | Purpose |
|---|---|
| `.settings` | View automation settings |
| `.mode public` | Public mode |
| `.mode private` | Private mode |
| `.setprefix <prefix>` | Change command prefix |
| `.ban @user` | Ban a user |
| `.unban @user` | Unban a user |
| `.report <message>` | Send a report to the owner |

🔒 Commands marked as administrative are available to the configured owner and **Master Sudo**. Master Sudo also bypasses private mode.

## 💾 Runtime data

```text
Killnet-XMD/
├── data/
│   ├── settings.json
│   ├── autoreply.json
│   ├── anticall.json
│   ├── banned.json
│   └── antilink.json
├── session/                  # WhatsApp authentication — keep private
├── config.js
├── index.js
├── package.json
└── README.md
```

## 🔄 Reconnection

Killnet XMD recreates the socket for transient disconnects and restart-required states, while permanent logout conditions require a new pairing. This prevents normal connection interruptions from being treated as permanent authentication failures.

## 🧪 Validation

Run:

```bash
npm test
```

CI performs JavaScript validation on Node.js 20. A syntax/CI pass cannot replace a live WhatsApp test: pairing, message delivery, Status events, calls and group operations require a real linked account.

## ⚠️ Responsible use

Killnet XMD uses the unofficial WhatsApp Web API through Baileys. Use it responsibly. Do not use it for spam, bulk unsolicited messaging, stalking, harassment, or other abusive automation. Follow WhatsApp's terms and applicable laws.

Baileys currently lists `7.0.0-rc14` as its latest npm release, with `6.7.24` maintained as a legacy line. citeturn1search9

## 👨‍💻 Credits

**Killnet XMD**  
Created by **Dian Sybex Tech**.

Built with **Baileys**.
