/**
 * Request header rewrite rule.
 *
 * Adds a custom header and strips the Referer from outgoing requests.
 * Drop this file in: ~/.proxy-rules/rules/api.example.com/index.ts
 */
import type { ProxyRule } from "proxy-rules/types";

const rule: ProxyRule = {
  target: "https://api.example.com",

  onRequest(ctx) {
    ctx.proxyReq.setHeader("X-Proxy-Rules", "1");
    ctx.proxyReq.removeHeader("referer");
  },

  logging: { enabled: true, captureBody: false },
};

export default rule;
