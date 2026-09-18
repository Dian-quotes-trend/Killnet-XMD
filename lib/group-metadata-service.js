// Killnet XMD — Phase 1D group metadata service
// Keeps group name, picture and invite-link operations out of command handlers.

function assertGroupJid(groupJid) {
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) {
    const error = new Error('A group JID is required.');
    error.code = 'INVALID_GROUP';
    throw error;
  }
}

function requireSocketMethod(sock, method) {
  if (!sock || typeof sock[method] !== 'function') {
    const error = new Error(`WhatsApp socket method ${method} is unavailable.`);
    error.code = 'SOCKET_METHOD_UNAVAILABLE';
    throw error;
  }
}

async function setGroupName(sock, groupJid, name) {
  assertGroupJid(groupJid);
  requireSocketMethod(sock, 'groupUpdateSubject');
  const subject = String(name || '').trim();
  if (!subject) throw new Error('Group name cannot be empty.');
  return sock.groupUpdateSubject(groupJid, subject);
}

async function setGroupPicture(sock, groupJid, image) {
  assertGroupJid(groupJid);
  requireSocketMethod(sock, 'updateProfilePicture');
  if (!image) throw new Error('Group picture data is required.');

  let data = image;
  if (typeof image === 'string' && /^https?:\\/\\//i.test(image)) data = { url: image };
  if (data && typeof data === 'object' && data.url) {
    const response = await fetch(String(data.url), { redirect: 'follow' });
    if (!response.ok) throw new Error(`Group picture download failed: HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error('Group picture URL must return an image.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Group picture download returned no data.');
    data = buffer;
  }
  return sock.updateProfilePicture(groupJid, { image: data });
}

async function getGroupInviteCode(sock, groupJid) {
  assertGroupJid(groupJid);
  requireSocketMethod(sock, 'groupInviteCode');
  const code = await sock.groupInviteCode(groupJid);
  if (!code) throw new Error('Group invite code is unavailable.');
  return code;
}

async function getGroupInviteLink(sock, groupJid) {
  const code = await getGroupInviteCode(sock, groupJid);
  return `https://chat.whatsapp.com/${code}`;
}

module.exports = {
  assertGroupJid,
  requireSocketMethod,
  setGroupName,
  setGroupPicture,
  getGroupInviteCode,
  getGroupInviteLink,
};
