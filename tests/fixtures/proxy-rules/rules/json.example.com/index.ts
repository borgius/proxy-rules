/**
 * Response body rewrite rule.
 *
 * Replaces a specific string in JSON API responses.
 * Drop this file in: ~/.proxy-rules/rules/json.example.com/index.ts
 */
import type { ProxyRule } from "proxy-rules/types";

const rule: ProxyRule = {
  target: "https://json.example.com",

  modifyResponseBody(body, ctx) {
    if (ctx.contentType?.includes("application/json")) {
      return body.replace(/"env":\s*"production"/, '"env": "intercepted"');
    }
    return undefined; // leave other content types unchanged
  },

  logging: { enabled: true, captureBody: true },
};

export default rule;
