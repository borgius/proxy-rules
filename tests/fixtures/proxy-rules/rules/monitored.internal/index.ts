/**
 * Logging-only rule (no target override, no body mutation).
 *
 * Just logs all CONNECT tunnels and requests for the monitored domain.
 * Drop this file in: ~/.proxy-rules/rules/monitored.internal/index.ts
 */
import type { ProxyRule } from "proxy-rules/types";

const rule: ProxyRule = {
  onConnect(ctx) {
    console.log(`[monitored.internal] CONNECT ${ctx.authority}`);
  },

  onRequest(ctx) {
    console.log(`[monitored.internal] ${ctx.req.method} ${ctx.url}`);
  },

  onWebSocketOpen(domain, req) {
    console.log(`[monitored.internal] WS opened: ${domain} ${req.url}`);
  },

  onWebSocketClose(domain) {
    console.log(`[monitored.internal] WS closed: ${domain}`);
  },

  logging: { enabled: true, captureBody: true },
};

export default rule;
