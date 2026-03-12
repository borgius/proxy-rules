/**
 * EXAMPLE: Request body (payload) modification.
 *
 * Intercepts the incoming request body, parses and modifies it, then writes
 * the updated payload to the upstream.
 *
 * HOW IT WORKS
 * ────────────
 * http-proxy streams req → proxyReq via req.pipe(proxyReq) AFTER the
 * proxyReq event fires (i.e. after onRequest returns).  To replace the body
 * we must:
 *   1. Override req.pipe() with a no-op so http-proxy doesn't also stream
 *      the original body.
 *   2. Accumulate chunks from req ourselves.
 *   3. Write the modified body to proxyReq and call proxyReq.end().
 *
 * Drop this file in: ~/.proxy-rules/rules/payload.example.com/index.js
 */

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://payload.example.com",

  onRequest(ctx) {
    const { req, proxyReq } = ctx;

    // Only intercept requests that carry a body.
    if (!["POST", "PUT", "PATCH"].includes(req.method ?? "")) return;

    const chunks = /** @type {Buffer[]} */ ([]);

    // ── Step 1: prevent http-proxy from piping the original body ──────────
    // We will call proxyReq.end() ourselves with the modified payload.
    req.pipe = () => req;

    // ── Step 2: accumulate the incoming body ──────────────────────────────
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");

      let modified = raw;
      const contentType = req.headers["content-type"] ?? "";

      if (contentType.includes("application/json")) {
        // ── JSON payload: parse → mutate → re-serialise ──────────────────
        try {
          const json = JSON.parse(raw);

          // Example mutations ↓ — adjust to your needs.

          // Inject a server-side timestamp the client never needs to send.
          json._proxyTimestamp = Date.now();

          // Remove a sensitive field before it reaches the upstream.
          delete json.internalDebugFlag;

          // Rename a field for legacy API compatibility.
          if (json.userId !== undefined) {
            json.user_id = json.userId;
            delete json.userId;
          }

          modified = JSON.stringify(json);
          proxyReq.setHeader("Content-Type", "application/json");
        } catch {
          // Body wasn't valid JSON — forward unchanged.
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        // ── Form payload: manipulate via URLSearchParams ──────────────────
        const params = new URLSearchParams(raw);
        params.set("source", "proxy");           // inject
        params.delete("utm_source");             // strip tracking
        modified = params.toString();
        proxyReq.setHeader("Content-Type", "application/x-www-form-urlencoded");
      }

      // ── Step 3: write modified body and end the upstream request ─────────
      const buf = Buffer.from(modified, "utf-8");
      proxyReq.setHeader("Content-Length", buf.length);
      proxyReq.end(buf);
    });
  },
};

export default rule;
