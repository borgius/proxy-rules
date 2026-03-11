import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import type httpProxy from "http-proxy";
import type { PluginRegistry } from "../plugins/plugin-registry.ts";
import { extractHostname, normalizeHostname } from "../plugins/plugin-registry.ts";
import { getDomainCert } from "../tls/cert-generator.ts";
import type { CaAssets } from "../tls/ca-store.ts";
import type { ResolvedPaths } from "../config/load-config.ts";
import type { ProxyConfig } from "../config/schema.ts";
import { handleHttpRequest } from "./http-handler.ts";
import { handleWebSocketUpgrade } from "./websocket-handler.ts";
import { getLogger } from "../logging/logger.ts";

export interface ConnectTarget {
  authority: string;
  hostname: string;
  port: number;
}

export function parseConnectTarget(authority: string): ConnectTarget {
  const trimmed = authority.trim();

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const hostname = end !== -1 ? trimmed.slice(0, end + 1) : trimmed;
    const portPart = end !== -1 && trimmed[end + 1] === ":"
      ? trimmed.slice(end + 2)
      : "";

    return {
      authority: trimmed,
      hostname,
      port: Number.parseInt(portPart, 10) || 443,
    };
  }

  const separator = trimmed.lastIndexOf(":");
  const hasPort = separator !== -1 && trimmed.indexOf(":") === separator;

  return {
    authority: trimmed,
    hostname: hasPort ? trimmed.slice(0, separator) : trimmed,
    port: hasPort ? Number.parseInt(trimmed.slice(separator + 1), 10) || 443 : 443,
  };
}

export function shouldInterceptConnect(
  authority: string,
  registry: PluginRegistry,
): boolean {
  const { hostname } = parseConnectTarget(authority);
  return registry.resolve(hostname) !== null;
}

function createPassthroughTunnel(
  clientSocket: net.Socket,
  target: ConnectTarget,
  head: Buffer,
  domain: string,
): void {
  const logger = getLogger();
  const upstreamSocket = net.connect(target.port, target.hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  upstreamSocket.on("error", (err) => {
    logger.debug("Upstream passthrough socket error", { domain, error: err.message });
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
  });

  clientSocket.on("error", (err) => {
    logger.debug("Client socket error during passthrough CONNECT", {
      domain,
      error: err.message,
    });
    upstreamSocket.destroy();
  });
}

/**
 * Handle an HTTP CONNECT request by performing MITM TLS interception.
 *
 * Flow:
 *  1. Parse the authority (host:port) from the CONNECT line.
 *  2. Reply 200 Connection Established to the client.
 *  3. Wrap the raw socket in a local TLS server using a per-domain leaf cert
 *     signed by our CA.
 *  4. Create an internal HTTP server on that TLS server that routes decrypted
 *     requests through the normal http-handler / websocket-handler pipeline.
 */
export async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  proxy: httpProxy,
  registry: PluginRegistry,
  config: ProxyConfig,
  ca: CaAssets,
  paths: ResolvedPaths,
): Promise<void> {
  const logger = getLogger();
  const target = parseConnectTarget(req.url ?? "");
  const authority = target.authority;
  const hostname = target.hostname;
  const domain = normalizeHostname(
    extractHostname(hostname),
    config.ignoreSubDomains,
  );

  logger.info("⬌ CONNECT", { authority, domain });

  // Fire onConnect hook if defined
  const rule = registry.resolve(hostname);

  if (!rule) {
    logger.debug("No matching rule for CONNECT — using passthrough tunnel", {
      authority,
      domain,
    });
    createPassthroughTunnel(clientSocket, target, head, domain);
    return;
  }

  if (rule?.onConnect) {
    try {
      await rule.onConnect({ socket: clientSocket, authority, domain });
    } catch (err) {
      logger.error("onConnect hook error", { domain, error: (err as Error).message });
    }
  }

  // Respond to client: tunnel acknowledged
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  // Obtain (or generate) a leaf cert for this domain
  let certPem: string;
  let keyPem: string;
  try {
    const domainCert = getDomainCert(domain, paths.certsDomainDir, ca);
    certPem = domainCert.certPem;
    keyPem = domainCert.keyPem;
  } catch (err) {
    logger.error("Failed to obtain domain cert, dropping CONNECT", {
      domain,
      error: (err as Error).message,
    });
    clientSocket.destroy();
    return;
  }

  // Create a local TLS server that impersonates the target
  const tlsServer = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: keyPem,
    cert: certPem,
  });

  tlsServer.on("error", (err) => {
    logger.debug("TLS socket error", { domain, error: err.message });
  });

  clientSocket.on("error", (err) => {
    logger.debug("Client socket error during CONNECT", { domain, error: err.message });
  });

  // Spin up a minimal HTTP(S) server to parse the decrypted stream
  const innerServer = http.createServer((innerReq, innerRes) => {
    // Restore the original host so plugin resolution works consistently
    if (!innerReq.headers["host"]) {
      innerReq.headers["host"] = hostname;
    }
    handleHttpRequest(innerReq, innerRes, proxy, registry, config, ca);
  });

  innerServer.on("upgrade", (innerReq, innerSocket, innerHead) => {
    handleWebSocketUpgrade(innerReq, innerSocket as net.Socket, innerHead, proxy, registry, config);
  });

  innerServer.on("error", (err) => {
    logger.debug("Inner CONNECT server error", { domain, error: err.message });
  });

  // Feed the TLS socket to the inner HTTP parser
  innerServer.emit("connection", tlsServer);

  if (head && head.length > 0) {
    tlsServer.unshift(head);
  }
}
