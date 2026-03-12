/**
 * EXAMPLE: A/B traffic splitting — route a percentage of requests to a
 * canary or staging backend.
 *
 * `resolveTarget` is called for every request. A deterministic hash of the
 * request URL keeps the same URL on the same backend within a session —
 * useful for reproducible testing. Switch to `Math.random()` if you prefer
 * random per-request splitting.
 *
 * Drop this file in: ~/.proxy-rules/rules/shop.example.com/index.js
 *
 * Traffic split
 * ─────────────
 *   80%  → https://shop.example.com            (production)
 *   20%  → https://staging.shop.example.com    (canary)
 */

const PRODUCTION = "https://shop.example.com";
const CANARY     = "https://staging.shop.example.com";
const CANARY_PCT = 0.20;   // 20 % routed to canary

/**
 * Simple djb2 hash — deterministic routing by URL.
 * @param {string} url
 * @returns {number}
 */
function hashUrl(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h) ^ url.charCodeAt(i);
    h = h >>> 0; // keep as uint32
  }
  return h;
}

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  resolveTarget(req) {
    const bucket = hashUrl(req.url ?? "/") / 0xffffffff;
    return bucket < CANARY_PCT ? CANARY : PRODUCTION;
  },

  onRequest(ctx) {
    const isCanary = ctx.proxyReq.host?.startsWith("staging.");
    ctx.proxyReq.setHeader("X-Canary", isCanary ? "true" : "false");
  },
};

export default rule;
