import httpProxy from "http-proxy";
import type http from "node:http";
import { getLogger } from "../logging/logger.ts";

/**
 * Create a shared node-http-proxy instance with base error handling wired up.
 * Individual request handlers call proxy.web() / proxy.ws() as needed.
 */
export function createProxyServer(): httpProxy {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    secure: false,        // Don't verify upstream TLS certs by default (MITM CA used)
    selfHandleResponse: false,
  });

  proxy.on("error", (err, req, res) => {
    const logger = getLogger();
    const target = (req as http.IncomingMessage & { proxyTarget?: string }).proxyTarget ?? "unknown";
    logger.error("Proxy error", {
      error: err.message,
      url: (req as http.IncomingMessage).url ?? "",
      target,
    });

    if (res && !("headersSent" in res && (res as http.ServerResponse).headersSent)) {
      (res as http.ServerResponse).writeHead(502, { "Content-Type": "text/plain" });
      (res as http.ServerResponse).end("Bad Gateway — proxy error");
    }
  });

  return proxy;
}
