import type http from "node:http";
import https from "node:https";
import httpProxy from "http-proxy";
import type { ProxyRule, StaticResponse } from "../plugins/types.ts";
import { createContextHelpers } from "../plugins/context-helpers.ts";
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
 * Buffer the full body of an incoming request stream up to `maxBytes`.
 * Returns the buffer, or `null` when the body exceeds the limit.
 * The stream is fully drained in either case so the socket stays healthy.
 */
export function bufferIncomingBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (!overLimit) {
        if (size <= maxBytes) {
          chunks.push(chunk);
        } else {
          overLimit = true;
          chunks.length = 0; // release memory — we won't use these
        }
      }
    });

    req.on("end", () => resolve(overLimit ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
  preBufferedRequestBody: Buffer | null = null,
): void {
  const startTime = Date.now();

  // Attach the pre-buffered request body so toCurl can read it without an
  // explicit `bodies` argument.
  if (preBufferedRequestBody !== null) {
    (req as http.IncomingMessage & { _body?: string })._body = preBufferedRequestBody.toString("utf-8");
  }

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
  // Also run the optional onRequest hook and modifyRequestBody from the rule.
  proxy.once("proxyReq", (proxyReq: http.ClientRequest) => {
    proxyReq.setHeader("accept-encoding", "identity");
    void (async () => {
      try {
        // onRequest — may return a StaticResponse.
        if (rule.onRequest) {
          const result = await rule.onRequest({ req, proxyReq, res, domain, url: req.url ?? "" });
          if (result != null) {
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
            return;
          }
        }

        // modifyRequestBody — write pre-buffered (and possibly modified) body.
        if (preBufferedRequestBody !== null) {
          const contentType = Array.isArray(req.headers["content-type"])
            ? req.headers["content-type"][0]
            : req.headers["content-type"];
          const raw = preBufferedRequestBody.toString("utf-8");
          let modified: string | undefined;

          if (rule.modifyRequestBody) {
            try {
              modified = await rule.modifyRequestBody(raw, {
                req,
                proxyReq,
                res,
                domain,
                url: req.url ?? "",
                contentType,
              });
            } catch (err) {
              logger.error("modifyRequestBody error", { domain, error: (err as Error).message });
            }
          }

          const buf = modified !== undefined ? Buffer.from(modified, "utf-8") : preBufferedRequestBody;
          proxyReq.setHeader("content-length", buf.length);
          proxyReq.removeHeader("transfer-encoding");
          proxyReq.end(buf);
        }
      } catch (err) {
        logger.error("onRequest hook error", { domain, error: (err as Error).message });
      }
    })();
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
      // Attach so toCurl(req, proxyRes) picks it up automatically.
      (proxyRes as http.IncomingMessage & { _body?: string })._body = body;
      let modified: string | undefined;

      try {
        modified = await modifyResponseBody(body, {
          req,
          proxyRes,
          res,
          domain,
          contentType,
          helpers: createContextHelpers(),
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
          await rule.onResponse({ req, proxyRes, res, domain, helpers: createContextHelpers() });
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
