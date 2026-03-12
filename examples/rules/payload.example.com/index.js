/**
 * EXAMPLE: Request body (payload) modification.
 *
 * Uses `modifyRequestBody` to parse and rewrite the incoming request body
 * before it is forwarded to the upstream.  The proxy handles all buffering
 * and re-sending — you just return the modified string (or `undefined` to
 * leave it unchanged).
 *
 * Drop this file in: ~/.proxy-rules/rules/payload.example.com/index.js
 */

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://payload.example.com",

  /**
   * @param {string} body  Raw request body as a UTF-8 string.
   * @param {import('proxy-rules/types').RequestBodyContext} ctx
   * @returns {string | undefined}
   */
  modifyRequestBody(body, ctx) {
    const contentType = ctx.contentType ?? "";

    // ── JSON payload ──────────────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        return undefined; // not valid JSON — leave unchanged
      }

      // Inject a server-side timestamp.
      json._proxyTimestamp = Date.now();

      // Strip a field that the upstream should never see.
      delete json.internalDebugFlag;

      // Rename a field for legacy API compatibility.
      if (json.userId !== undefined) {
        json.user_id = json.userId;
        delete json.userId;
      }

      return JSON.stringify(json);
    }

    // ── URL-encoded form payload ───────────────────────────────────────────
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      params.set("source", "proxy");    // inject
      params.delete("utm_source");      // strip tracking param
      return params.toString();
    }

    return undefined; // leave all other content types unchanged
  },
};

export default rule;
