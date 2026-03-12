/**
 * EXAMPLE: CORS preflight handler + dynamic origin allowlist.
 *
 * Intercepts OPTIONS requests and replies with CORS headers immediately
 * (upstream never sees preflight). For all other methods, forwards to the
 * upstream with an injected Authorization header derived from the request.
 *
 * Drop this file in: ~/.proxy-rules/rules/cors.example.com/index.js
 */

const ALLOWED_ORIGINS = new Set([
  "https://app.example.com",
  "https://dev.example.com",
  "http://localhost:3000",
]);

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://cors.example.com",

  onRequest(ctx) {
    const origin = ctx.req.headers["origin"] ?? "";

    // Handle preflight entirely — upstream is never contacted.
    if (ctx.req.method === "OPTIONS") {
      const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "";
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  allowed,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age":       "86400",
          "Vary":                         "Origin",
        },
      };
    }

    // For real requests — add origin header and forward.
    if (ALLOWED_ORIGINS.has(origin)) {
      ctx.proxyReq.setHeader("Access-Control-Allow-Origin", origin);
    }
  },
};

export default rule;
