import type http from "node:http";
import type net from "node:net";
import type httpProxy from "http-proxy";
import type { PluginRegistry } from "../plugins/plugin-registry.ts";
import { extractHostname, normalizeHostname } from "../plugins/plugin-registry.ts";
import { getLogger } from "../logging/logger.ts";
import type { ProxyConfig } from "../config/schema.ts";

/**
 * Handle a WebSocket upgrade request.
 *
 * Uses node-http-proxy's ws() method and fires plugin lifecycle hooks.
 */
export function handleWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  proxy: httpProxy,
  registry: PluginRegistry,
  config: ProxyConfig,
): void {
  const logger = getLogger();

  const rawHost = req.headers["host"] ?? "";
  const hostname = extractHostname(rawHost);
  const domain = normalizeHostname(hostname, config.ignoreSubDomains);
  const rule = registry.resolve(rawHost);

  let target: string;
  if (rule?.target) {
    // Convert http(s) target to ws(s)
    target = rule.target.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  } else {
    target = `ws://${rawHost}`;
  }

  logger.info("⬌ WS upgrade", { domain, target });

  rule?.onWebSocketOpen?.(domain, req);

  proxy.ws(req, socket, head, { target }, (err) => {
    if (err) {
      logger.error("WebSocket proxy error", { domain, error: (err as Error).message });
      socket.destroy();
    }
  });

  socket.on("close", () => {
    rule?.onWebSocketClose?.(domain);
    logger.debug("WS closed", { domain });
  });
}
