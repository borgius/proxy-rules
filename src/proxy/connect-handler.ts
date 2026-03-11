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

async function createInterceptTunnel(
  clientSocket: net.Socket,
  head: Buffer,
  hostname: string,
  domain: string,
  proxy: httpProxy,
  registry: PluginRegistry,
  config: ProxyConfig,
  certPem: string,
  keyPem: string,
): Promise<void> {
  const logger = getLogger();

  const innerServer = http.createServer((innerReq, innerRes) => {
    if (!innerReq.headers["host"]) {
      innerReq.headers["host"] = hostname;
    }
    handleHttpRequest(innerReq, innerRes, proxy, registry, config);
  });

  innerServer.on("upgrade", (innerReq, innerSocket, innerHead) => {
    handleWebSocketUpgrade(innerReq, innerSocket as net.Socket, innerHead, proxy, registry, config);
  });

  innerServer.on("error", (err) => {
    logger.debug("Inner CONNECT server error", { domain, error: err.message });
  });

  innerServer.on("clientError", (err, socket) => {
    logger.debug("Inner HTTP parser error", { domain, error: err.message });
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    let mitmServer: tls.Server | undefined;

    let settled = false;

    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const cleanup = () => {
      innerServer.close();
      mitmServer?.close();
    };

    clientSocket.on("error", (err) => {
      logger.debug("Client socket error during CONNECT", { domain, error: err.message });
    });

    innerServer.listen(0, "127.0.0.1", () => {
      const innerAddress = innerServer.address();
      if (!innerAddress || typeof innerAddress === "string") {
        finish(new Error("Failed to resolve local inner HTTP server address"));
        return;
      }

      logger.debug("Inner HTTP bridge server listening", {
        domain,
        port: innerAddress.port,
      });

      mitmServer = tls.createServer(
        {
          key: keyPem,
          cert: certPem,
          ALPNProtocols: ["http/1.1"],
        },
        (tlsSocket) => {
          logger.debug("MITM TLS server accepted secure connection", { domain });

          tlsSocket.pause();
          const pendingChunks: Buffer[] = [];
          let innerBridgeReady = false;

          tlsSocket.on("error", (err) => {
            logger.debug("TLS socket error", { domain, error: err.message });
          });

          tlsSocket.on("data", (chunk) => {
            if (!innerBridgeReady) {
              pendingChunks.push(Buffer.from(chunk));
              return;
            }

            const ok = innerBridgeSocket.write(chunk);
            if (!ok) {
              tlsSocket.pause();
            }
          });

          const innerBridgeSocket = net.connect(innerAddress.port, "127.0.0.1", () => {
            logger.debug("Connected decrypted TLS stream to inner HTTP server", { domain });

            innerBridgeReady = true;

            for (const chunk of pendingChunks) {
              const ok = innerBridgeSocket.write(chunk);
              if (!ok) {
                tlsSocket.pause();
                break;
              }
            }

            pendingChunks.length = 0;

            innerBridgeSocket.on("drain", () => {
              tlsSocket.resume();
            });

            innerBridgeSocket.on("data", (chunk) => {
              const ok = tlsSocket.write(chunk);
              if (!ok) {
                innerBridgeSocket.pause();
              }
            });

            tlsSocket.on("drain", () => {
              innerBridgeSocket.resume();
            });

            tlsSocket.resume();
          });

          innerBridgeSocket.on("error", (err) => {
            logger.debug("Inner HTTP bridge socket error", { domain, error: err.message });
            tlsSocket.destroy();
            cleanup();
          });

          innerBridgeSocket.on("close", cleanup);
          tlsSocket.on("close", () => {
            innerBridgeSocket.destroy();
            cleanup();
          });
        },
      );

      mitmServer.on("tlsClientError", (err) => {
        logger.debug("TLS client handshake error", { domain, error: err.message });
      });

      mitmServer.on("error", (err) => {
        logger.debug("TLS server error", { domain, error: err.message });
        finish(err);
      });

      mitmServer.listen(0, "127.0.0.1", () => {
        const mitmAddress = mitmServer?.address();
        if (!mitmAddress || typeof mitmAddress === "string") {
          finish(new Error("Failed to resolve local MITM server address"));
          return;
        }

        logger.debug("Local MITM TLS bridge server listening", {
          domain,
          port: mitmAddress.port,
        });

        const bridgeSocket = net.connect(mitmAddress.port, "127.0.0.1", () => {
          logger.debug("Client CONNECT tunnel bridged into local MITM TLS server", {
            domain,
          });
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

          if (head.length > 0) {
            bridgeSocket.write(head);
          }

          clientSocket.pipe(bridgeSocket);
          bridgeSocket.pipe(clientSocket);
          finish();
        });

        bridgeSocket.on("error", (err) => {
          logger.debug("Local MITM bridge socket error", { domain, error: err.message });
          cleanup();
          finish(err);
        });

        bridgeSocket.on("close", cleanup);
        clientSocket.on("close", cleanup);
      });
    });
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

  await createInterceptTunnel(
    clientSocket,
    head,
    hostname,
    domain,
    proxy,
    registry,
    config,
    certPem,
    keyPem,
  );
}
