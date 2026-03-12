/**
 * EXAMPLE: Response header manipulation.
 *
 * Uses `onResponse` to add, override, and strip headers from the upstream
 * response before it reaches the client.  The response body is NOT buffered
 * or modified — this hook is purely for headers.
 *
 * Drop this file in: ~/.proxy-rules/rules/resp-headers.example.com/index.js
 */

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://resp-headers.example.com",

  onResponse(ctx) {
    const { proxyRes } = ctx;

    // ── Inject security headers the upstream forgot to set ────────────────
    proxyRes.headers["strict-transport-security"] =
      "max-age=31536000; includeSubDomains";
    proxyRes.headers["x-content-type-options"]  = "nosniff";
    proxyRes.headers["x-frame-options"]          = "DENY";
    proxyRes.headers["referrer-policy"]          = "strict-origin-when-cross-origin";

    // ── Override CORS headers from the upstream ───────────────────────────
    // Replace a wildcard origin with a specific allow-list entry.
    const origin = ctx.req.headers["origin"] ?? "";
    const ALLOWED = new Set(["https://app.example.com", "https://dev.example.com"]);
    if (ALLOWED.has(origin)) {
      proxyRes.headers["access-control-allow-origin"] = origin;
      proxyRes.headers["vary"] = "Origin";
    } else {
      delete proxyRes.headers["access-control-allow-origin"];
    }

    // ── Shorten an overly-long cache TTL ─────────────────────────────────
    const cc = proxyRes.headers["cache-control"];
    if (typeof cc === "string" && cc.includes("max-age=86400")) {
      proxyRes.headers["cache-control"] = cc.replace("max-age=86400", "max-age=3600");
    }

    // ── Remove headers that leak internal infrastructure details ──────────
    delete proxyRes.headers["server"];
    delete proxyRes.headers["x-powered-by"];
    delete proxyRes.headers["x-aspnet-version"];
    delete proxyRes.headers["x-generator"];

    // ── Add a custom header so clients know the proxy processed the response
    proxyRes.headers["x-proxied-by"] = "proxy-rules";
  },
};

export default rule;
