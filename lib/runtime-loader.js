'use strict';

/**
 * Compatibility preload for existing deployments.
 *
 * The live lifecycle is now attached explicitly by index.js after the
 * production Baileys socket is created. Keeping socket wrapping here would
 * create a second lifecycle instance and duplicate message automations and
 * moderation actions, so this preload intentionally performs no transport
 * interception.
 */
module.exports = {};
