/**
 * EXAMPLE: Request header manipulation.
 *
 * Demonstrates the full range of header operations available in `onRequest`:
 *   - Adding new headers
 *   - Overriding existing headers
 *   - Removing headers
 *   - Injecting auth from an environment variable
 *   - Forwarding client IP to the upstream
 *
 * Drop this file in: ~/.proxy-rules/rules/headers.example.com/index.js
 */

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://headers.example.com",

  onRequest(ctx) {
    const { proxyReq, req } = ctx;

    // ── Add a new header ──────────────────────────────────────────────────
    proxyReq.setHeader("X-Proxy-Version", "1.0");

    // ── Override an existing header ───────────────────────────────────────
    // Change the User-Agent that reaches the upstream.
    proxyReq.setHeader("User-Agent", "my-proxy/1.0");

    // ── Remove a header ───────────────────────────────────────────────────
    // Strip the Referer so the upstream never sees where the client came from.
    proxyReq.removeHeader("Referer");
    // Also strip cookies for unauthenticated API calls.
    proxyReq.removeHeader("Cookie");

    // ── Inject an API key from the environment ────────────────────────────
    // Store secrets in env vars, not in rule files.
    const apiKey = process.env.UPSTREAM_API_KEY;
    if (apiKey) {
      proxyReq.setHeader("Authorization", `Bearer ${apiKey}`);
    }

    // ── Forward the real client IP to the upstream ────────────────────────
    // Many upstreams trust X-Forwarded-For for rate-limiting / logging.
    const clientIp =
      req.headers["x-forwarded-for"] ??
      req.socket.remoteAddress ??
      "unknown";
    proxyReq.setHeader("X-Forwarded-For", clientIp);
    proxyReq.setHeader("X-Forwarded-Host", req.headers["host"] ?? "");
    proxyReq.setHeader("X-Forwarded-Proto", "https");

    // ── Conditionally add headers based on request context ────────────────
    if (req.headers["accept-language"]?.startsWith("de")) {
      proxyReq.setHeader("X-Region", "DE");
    }
  },
};

export default rule;
