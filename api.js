/**
 * Standalone runtime compatibility shim.
 *
 * The bot no longer exposes an HTTP/Socket.IO dashboard transport.
 * index.js still calls startAPI for backwards compatibility, so this
 * function intentionally does nothing and never opens a listening socket.
 */
function startAPI() {
  return null;
}

module.exports = { startAPI };
