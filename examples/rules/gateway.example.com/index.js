/**
 * EXAMPLE: Path-based routing — send different paths to different backends.
 *
 * Uses `resolveTarget` to dynamically pick the upstream URL before the
 * connection is opened. `onRequest` still runs (and can modify headers),
 * but the target has already been chosen.
 *
 * Drop this file in: ~/.proxy-rules/rules/gateway.example.com/index.js
 *
 * Routing table
 * ─────────────
 *   /api/v2/*   → https://v2.api.internal
 *   /api/v1/*   → https://v1.api.internal
 *   /static/*   → https://cdn.example.com
 *   everything  → https://gateway.example.com  (fallback)
 */

/** @type {Array<{ prefix: string, target: string }>} */
const ROUTES = [
  { prefix: "/api/v2", target: "https://v2.api.internal" },
  { prefix: "/api/v1", target: "https://v1.api.internal" },
  { prefix: "/static", target: "https://cdn.example.com" },
];

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  // Fallback target when no route matches.
  target: "https://gateway.example.com",

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {string | undefined}
   */
  resolveTarget(req) {
    const path = req.url ?? "/";
    const match = ROUTES.find((r) => path.startsWith(r.prefix));
    // Return undefined to keep the static fallback `target` above.
    return match?.target;
  },

  onRequest(ctx) {
    ctx.proxyReq.setHeader("X-Gateway", "proxy-rules");
  },
};

export default rule;
