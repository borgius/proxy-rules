import type http from "node:http";
import type httpProxy from "http-proxy";
import type { ProxyRule } from "../plugins/types.ts";
import { getLogger } from "../logging/logger.ts";
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

/**
 * Run the selfHandleResponse pipeline used when a rule declares `modifyResponseBody`.
 * Buffers the upstream response body (up to maxBodyBytes), calls the modifier,
 * then writes the result to the client.
 */
export function runResponsePipeline(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  proxy: httpProxy,
  target: string,
  rule: ProxyRule,
  domain: string,
  config: ProxyConfig,
  logger: Logger,
): void {
  const maxBodyBytes = config.logging.maxBodyBytes;

  proxy.once("proxyRes", (proxyRes: http.IncomingMessage) => {
    const contentType = proxyRes.headers["content-type"];

    // Forward status and headers
    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);

    // Only buffer and mutate text-like responses within the size limit
    const contentLength = parseInt(proxyRes.headers["content-length"] ?? "0", 10);
    const canBuffer =
      isTextContentType(contentType) &&
      (contentLength === 0 || contentLength <= maxBodyBytes);

    if (!canBuffer || !rule.modifyResponseBody) {
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    proxyRes.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBodyBytes) {
        chunks.push(chunk);
      } else {
        // Buffer overrun — fall back to passthrough
        logger.warn("Response body exceeded maxBodyBytes, falling back to passthrough", {
          domain,
          contentType,
          size,
          maxBodyBytes,
        });
        // Drain remaining chunks directly to res
        const buffered = Buffer.concat(chunks);
        res.write(buffered);
        chunks.length = 0;
        proxyRes.pipe(res);
        proxyRes.removeAllListeners("data");
      }
    });

    proxyRes.on("end", async () => {
      if (chunks.length === 0) return; // already piped above

      const body = Buffer.concat(chunks).toString("utf-8");
      let modified: string | undefined;

      try {
        modified = await rule.modifyResponseBody!(body, {
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

      res.end(modified !== undefined ? modified : body);
    });

    proxyRes.on("error", (err) => {
      logger.error("proxyRes stream error", { domain, error: err.message });
      res.end();
    });
  });

  proxy.web(req, res, { target, selfHandleResponse: true });
}
