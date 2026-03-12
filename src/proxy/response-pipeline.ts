import type http from "node:http";
import https from "node:https";
import httpProxy from "http-proxy";
import type { ProxyRule, StaticResponse } from "../plugins/types.ts";
import type { ProxyConfig } from "../config/schema.ts";
import type { Logger } from "../logging/logger.ts";

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml",
  "application/javascript",
  "application/x-javascript",
];

function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return TEXT_CONTENT_TYPES.some((t) => contentType.includes(t));
}

function getSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function buildMutatedResponseHeaders(headers: http.IncomingHttpHeaders, body: string): http.OutgoingHttpHeaders {
  const nextHeaders: http.OutgoingHttpHeaders = { ...headers };
  nextHeaders["content-length"] = Buffer.byteLength(body, "utf8").toString();
  delete nextHeaders["transfer-encoding"];
  delete nextHeaders["content-encoding"];
  delete nextHeaders["etag"];

  return nextHeaders;
}

/**
 * Run the selfHandleResponse pipeline used when a rule declares `modifyResponseBody`.
 * Buffers the upstream response body (up to maxBodyBytes), calls the modifier,
 * then writes the result to the client.
 *
 * IMPORTANT: We create a REQUEST-SCOPED httpProxy instance instead of using the
 * global shared one.  The shared proxy is an EventEmitter; `proxy.once("proxyRes",
 * handler)` registers a one-shot listener on it.  With concurrent requests every
 * handler fires for whichever upstream response arrives first — not necessarily
 * the right one.  An isolated proxy per-call eliminates that race completely.
 */
export function runResponsePipeline(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _sharedProxy: httpProxy,   // kept in signature for call-site compat, not used here
  target: string,
  rule: ProxyRule,
  domain: string,
  config: ProxyConfig,
  logger: Logger,
): void {
  const startTime = Date.now();

  // Isolated proxy — events cannot bleed between concurrent requests.
  // Use a no-keepalive agent so every outbound request opens a fresh TCP/TLS
  // connection. Under Bun, the global HTTPS agent can hold stale connections
  // that the server has already closed, causing "socket connection was closed
  // unexpectedly" errors. Disabling keepAlive eliminates that entirely.
  const agent = target.startsWith("https") ? new https.Agent({ keepAlive: false }) : false;
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: false, agent });

  proxy.on("error", (err, _req, _res) => {
    logger.error("Proxy error in pipeline", { domain, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    if (!res.writableEnded) res.end("Bad Gateway — proxy error");
  });

  // Inject accept-encoding: identity so the upstream never gzip-encodes the body
  // (we can't decode compressed streams, so we'd be forced to passthrough unchanged).
  // Also run the optional onRequest hook from the rule.
  proxy.once("proxyReq", (proxyReq: http.ClientRequest) => {
    proxyReq.setHeader("accept-encoding", "identity");
    if (rule.onRequest) {
      void (async () => {
        try {
          const result = await rule.onRequest!({ req, proxyReq, res, domain, url: req.url ?? "" });
          if (result != null) {
            // Static response — abort upstream and reply directly.
            const { status = 200, headers = {}, body = "", contentType } = result as StaticResponse;
            const responseHeaders: http.OutgoingHttpHeaders = { ...headers };
            if (contentType && !responseHeaders["content-type"]) {
              responseHeaders["content-type"] = contentType;
            }
            if (!res.headersSent) {
              res.writeHead(status, responseHeaders);
              res.end(body);
            }
            proxyReq.destroy();
          }
        } catch (err) {
          logger.error("onRequest hook error", { domain, error: (err as Error).message });
        }
      })();
    }
  });

  // config.logging.maxBodyBytes is 0 when body logging is disabled.
  // For body modification we need a meaningful cap — treat 0 as "no logging
  // limit" and fall back to a sane 10 MB ceiling so modifyResponseBody runs
  // for typical API responses regardless of the logging setting.
  const loggingMaxBytes = config.logging.maxBodyBytes;
  const modifyMaxBytes = loggingMaxBytes > 0 ? loggingMaxBytes : 10 * 1024 * 1024;

  proxy.once("proxyRes", (proxyRes: http.IncomingMessage) => {
    const statusCode = proxyRes.statusCode ?? 200;
    const contentType = getSingleHeaderValue(proxyRes.headers["content-type"]);
    const contentEncoding = getSingleHeaderValue(proxyRes.headers["content-encoding"]);

    // Only buffer and mutate text-like responses within the size limit
    const contentLength = parseInt(getSingleHeaderValue(proxyRes.headers["content-length"]) ?? "0", 10);
    const canBuffer =
      isTextContentType(contentType) &&
      (!contentEncoding || contentEncoding.toLowerCase() === "identity") &&
      (contentLength === 0 || contentLength <= modifyMaxBytes);
    const modifyResponseBody = rule.modifyResponseBody;

    if (!canBuffer || !modifyResponseBody) {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let fellBackToPassthrough = false;

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= modifyMaxBytes) {
        chunks.push(chunk);
      } else {
        // Buffer overrun — fall back to passthrough
        logger.warn("Response body exceeded modify limit, falling back to passthrough", {
          domain,
          contentType,
          size,
          modifyMaxBytes,
        });

        fellBackToPassthrough = true;
        proxyRes.off("data", onData);
        res.writeHead(statusCode, proxyRes.headers);

        const buffered = Buffer.concat([...chunks, chunk]);
        res.write(buffered);
        chunks.length = 0;
        proxyRes.pipe(res);
      }
    };

    proxyRes.on("data", onData);

    proxyRes.on("end", async () => {
      if (fellBackToPassthrough || chunks.length === 0) return;

      const body = Buffer.concat(chunks).toString("utf-8");
      let modified: string | undefined;

      try {
        modified = await modifyResponseBody(body, {
          req,
          proxyRes,
          res,
          domain,
          contentType,
        });
      } catch (err) {
        logger.error("modifyResponseBody error", {
          domain,
          error: (err as Error).message,
        });
      }

      // Run optional onResponse hook before we write the (possibly mutated) response.
      if (rule.onResponse) {
        try {
          await rule.onResponse({ req, proxyRes, res, domain });
        } catch (err) {
          logger.error("onResponse hook error", { domain, error: (err as Error).message });
        }
      }

      const finalBody = modified !== undefined ? modified : body;
      res.writeHead(
        statusCode,
        buildMutatedResponseHeaders(proxyRes.headers, finalBody),
      );
      res.end(finalBody);

      logger.info("\u2190 HTTP", {
        method: req.method,
        url: req.url,
        domain,
        status: statusCode,
        ms: Date.now() - startTime,
        bodyModified: modified !== undefined,
      });
    });

    proxyRes.on("error", (err) => {
      logger.error("proxyRes stream error", { domain, error: err.message });
      if (!res.writableEnded) res.end();
    });
  });

  proxy.web(req, res, { target, selfHandleResponse: true });
}
