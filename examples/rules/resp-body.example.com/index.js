/**
 * EXAMPLE: Response body modification.
 *
 * Uses `modifyResponseBody` to rewrite the upstream response body.
 * The hook receives the fully-buffered body as a string and returns
 * the (optionally modified) replacement.
 *
 * Applies only to text-like responses (text/*, application/json,
 * application/xml, application/javascript) whose size is ≤ maxBodyBytes.
 * Binary responses and large payloads pass through unchanged.
 *
 * `onResponse` is also wired to remove a telemetry header from the upstream.
 *
 * Drop this file in: ~/.proxy-rules/rules/resp-body.example.com/index.js
 */

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://resp-body.example.com",

  // onResponse fires when upstream headers arrive (before body is buffered).
  // You can modify headers here even when modifyResponseBody is also set.
  onResponse(ctx) {
    delete ctx.proxyRes.headers["x-internal-trace-id"];
  },

  /**
   * @param {string} body
   * @param {import('proxy-rules/types').BodyContext} ctx
   * @returns {string | undefined}
   */
  modifyResponseBody(body, ctx) {
    const ct = ctx.contentType ?? "";

    // ── JSON responses ────────────────────────────────────────────────────
    if (ct.includes("application/json")) {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        return undefined; // invalid JSON — leave unchanged
      }

      // Inject a field only visible via the proxy.
      json._proxied = true;

      // Mask a sensitive field so it never reaches the browser.
      if (json.user?.ssn) {
        json.user.ssn = "***-**-" + String(json.user.ssn).slice(-4);
      }

      // Flatten a single-item array the client always unwraps anyway.
      if (Array.isArray(json.results) && json.results.length === 1) {
        json.result = json.results[0];
        delete json.results;
      }

      // Re-key camelCase → snake_case for a legacy client.
      if (json.userId !== undefined) {
        json.user_id = json.userId;
        delete json.userId;
      }

      return JSON.stringify(json);
    }

    // ── HTML responses ────────────────────────────────────────────────────
    if (ct.includes("text/html")) {
      // Inject a banner into every HTML page.
      const banner = `<div id="proxy-banner" style="background:#ff0;padding:4px;text-align:center">
        [PROXIED — dev environment]
      </div>`;

      // Insert right after <body> (case-insensitive).
      const modified = body.replace(/(<body[^>]*>)/i, `$1${banner}`);
      if (modified !== body) return modified;

      // Fallback: append before </body> if pattern above didn't match.
      return body.replace(/<\/body>/i, `${banner}</body>`);
    }

    // ── Plain text responses ──────────────────────────────────────────────
    if (ct.includes("text/plain")) {
      // Redact anything that looks like a credit-card number.
      return body.replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, "[REDACTED]");
    }

    // ── JavaScript responses ──────────────────────────────────────────────
    if (ct.includes("javascript")) {
      // Replace a feature flag value shipped inside a JS bundle.
      return body.replace(
        /FEATURE_NEW_DASHBOARD\s*[:=]\s*false/g,
        "FEATURE_NEW_DASHBOARD: true",
      );
    }

    // Return undefined to leave any other content type unchanged.
    return undefined;
  },

  logging: { enabled: true, captureBody: true },
};

export default rule;
