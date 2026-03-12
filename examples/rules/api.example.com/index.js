/**
 * EXAMPLE: Block specific paths — return 403, forward everything else.
 *
 * Intercepts requests to blocked paths and returns a 403 Forbidden
 * response. All other requests are forwarded to the upstream unchanged.
 *
 * Drop this file in: ~/.proxy-rules/rules/api.example.com/index.js
 */

const BLOCKED_PATHS = ["/admin", "/internal", "/debug"];

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://api.example.com",

  onRequest(ctx) {
    const path = new URL(ctx.url, "http://x").pathname;

    if (BLOCKED_PATHS.some((blocked) => path.startsWith(blocked))) {
      console.warn(`[api.example.com] blocked request to ${path}`);

      // Return a StaticResponse — upstream is NOT contacted.
      return {
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Forbidden", path }),
      };
    }

    // No return value → request is forwarded normally.
    ctx.proxyReq.setHeader("X-Forwarded-Via", "proxy-rules");
  },
};

export default rule;
