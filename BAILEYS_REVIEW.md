# Baileys API Review — W-MD Bot

## Target
- Upgraded `@whiskeysockets/baileys` from `6.7.16` to `7.0.0-rc14`.
- `7.0.0-rc14` is the current npm `latest` tag at the time of this review. `6.7.24` is the legacy tag.
- Supabase/Lovable Cloud URLs, keys, sync actions, dashboard auth flow, and other cloud connection code were intentionally left untouched.

## Baileys compatibility fixes

### 1. Media download API
Removed use of the non-existent socket method `sock.downloadMediaMessage(...)`.
Media downloads now use the exported Baileys `downloadContentFromMessage(...)` helper.

### 2. Delete-event handling
The anti-delete implementation was listening for deletion through `messages.update`/`messageStubType`.
It now listens to the dedicated `messages.delete` event used by current Baileys.

### 3. Delivery/read status mapping
Corrected message status handling:
- `2` = server acknowledged/sent
- `3` = delivered
- `4` = read
- `5` = played/read-equivalent

### 4. LID/PN handling
Added JID helpers that preserve `@lid` JIDs instead of blindly converting them to `@s.whatsapp.net`.
When WhatsApp supplies `remoteJidAlt`, `senderPn`, `participantPn`, or `participantAlt`, those values are preferred for the phone-number identity.

This is important for Baileys 7's LID/PN behavior.

### 5. Group metadata cache
Added a Baileys `cachedGroupMetadata` hook and local group metadata cache.
This reduces repeated group metadata queries and improves group-message reliability.

### 6. Current socket configuration
The socket continues to use:
- `fetchLatestBaileysVersion()`
- `makeCacheableSignalKeyStore()`
- `Browsers.ubuntu('Chrome')`
- pairing-code authentication
- QR events
- `creds.update`
- reconnect handling

`printQRInTerminal` is not used; QR is consumed from `connection.update`.

### 7. Session safety
Added `.gitignore` protection for:
- `session/`
- `data/`
- `.env`
- `node_modules/`

Do not commit the WhatsApp session directory.

## Remaining feature limitation

The `.sticker` command claims to accept image/video input. Baileys itself does not convert arbitrary JPEG/MP4 bytes into WebP stickers. The reviewed code now rejects video-to-sticker conversion explicitly instead of passing an MP4 buffer as a sticker and failing unpredictably.

To support video -> sticker, add a proper WebP/FFmpeg conversion pipeline.

## Verification performed

- `node --check index.js` passes after the changes.
- The project was reviewed against the current upstream Baileys API surface and current v7 documentation.
- No Supabase/Lovable Cloud authentication or connection implementation was modified.
