/**
 * EXAMPLE: Global URL-pattern rule — apply one HTTP rule to every matching request.
 *
 * Matches any HTTP request whose absolute URL contains `/v1/`, regardless of host.
 * This rule runs before the resolved domain rule for the request.
 *
 * Pair it with `examples/rules/api.example.com/index.js` to see both scopes coexist:
 * - this global rule tags matching `/v1/*` traffic across hosts
 * - the domain rule still adds host-specific behavior afterwards
 *
 * Drop this file in: ~/.proxy-rules/rules/global/path-prefix.js
 */

const PREFIX = "/v1/";

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  match: PREFIX,

  onRequest(ctx) {
    ctx.proxyReq.setHeader("X-Global-Path-Prefix", "v1");
  },

  onResponse(ctx) {
    ctx.proxyRes.headers["x-global-rule"] = "path-prefix";
  },
};

export default rule;