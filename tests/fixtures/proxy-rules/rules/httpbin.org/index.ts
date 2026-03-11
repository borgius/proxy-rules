/**
 * Passthrough rule — log all requests to httpbin.org and forward unchanged.
 *
 * Drop this file in: ~/.proxy-rules/rules/httpbin.org/index.ts
 */
import type { ProxyRule } from "proxy-rules/types";

const rule: ProxyRule = {
  target: "http://httpbin.org",

  onRequest(ctx) {
    console.log(`[httpbin.org] → ${ctx.req.method} ${ctx.url}`);
  },

  onResponse(ctx) {
    console.log(`[httpbin.org] ← ${ctx.proxyRes.statusCode}`);
  },

  logging: { enabled: true },
};

export default rule;
