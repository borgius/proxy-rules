import type http from "node:http";
import type httpProxy from "http-proxy";
import type { PluginRegistry } from "../plugins/plugin-registry.ts";
import { extractHostname, normalizeHostname } from "../plugins/plugin-registry.ts";
import { getLogger } from "../logging/logger.ts";
import type { ProxyConfig } from "../config/schema.ts";
import type { CaAssets } from "../tls/ca-store.ts";
import type { StaticResponse } from "../plugins/types.ts";
import { runResponsePipeline, bufferIncomingBody } from "./response-pipeline.ts";

function sendStaticResponse(res: http.ServerResponse, sr: StaticResponse): void {
  const { status = 200, headers = {}, body = "", contentType } = sr;
  const responseHeaders: http.OutgoingHttpHeaders = { ...headers };
  if (contentType && !responseHeaders["content-type"]) {
    responseHeaders["content-type"] = contentType;
  }
  if (!res.headersSent) {
    res.writeHead(status, responseHeaders);
    res.end(body);
  }
}

/**
 * Handle plain HTTP forward-proxy requests (where client sends absolute URIs).
 * Also handles relative requests arriving after CONNECT tunnel decryption.
 */
export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  proxy: httpProxy,
  registry: PluginRegistry,
  config: ProxyConfig,
  _ca?: CaAssets,
): Promise<void> {
  const logger = getLogger();

  const rawHost = req.headers["host"] ?? "";
  const hostname = extractHostname(rawHost);
  const domain = normalizeHostname(hostname, config.ignoreSubDomains);
  const rule = registry.resolve(rawHost);

  const startTime = Date.now();

  if (rule) {
    logger.info("→ HTTP", {
      method: req.method,
      url: req.url,
      domain,
    });
  }

  // Determine upstream target (static)
  let target: string;
  if (rule?.target) {
    target = rule.target;
  } else {
    // Passthrough: derive target from request
    const proto = req.url?.startsWith("https:") ? "https" : "http";
    target = `${proto}://${rawHost}`;
  }

  // Dynamic target override — runs before proxy.web() so the resolved URL
  // is used for the actual upstream connection.
  if (rule?.resolveTarget) {
    try {
      const resolved = await rule.resolveTarget(req, domain);
      if (resolved) target = resolved;
    } catch (err) {
      logger.error("resolveTarget hook error", {
        domain,
        error: (err as Error).message,
      });
    }
  }

  // Tag request with resolved target (for error handler)
  (req as http.IncomingMessage & { proxyTarget?: string }).proxyTarget = target;

  // Use the same byte cap as the response-body modifier.
  const loggingMaxBytes = config.logging.maxBodyBytes;
  const modifyMaxBytes = loggingMaxBytes > 0 ? loggingMaxBytes : 10 * 1024 * 1024;

  // Pre-buffer the request body when the rule declares modifyRequestBody.
  // We consume the stream here so it is fully available in the proxyReq handler.
  // req.pipe is overridden to a no-op so http-proxy does not also stream the
  // original (already-consumed) body.
  let preBufferedRequestBody: Buffer | null = null;
  if (rule?.modifyRequestBody) {
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
    const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "");
    if (hasBody && (contentLength === 0 || contentLength <= modifyMaxBytes)) {
      preBufferedRequestBody = await bufferIncomingBody(req, modifyMaxBytes);
      if (preBufferedRequestBody !== null) {
        // Prevent http-proxy from trying to pipe the already-consumed stream.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).pipe = () => req;
      }
    }
  }

  // Pipeline path: runs on its own isolated proxy — do NOT register listeners on
  // the shared proxy here, otherwise stale `once` handlers accumulate and fire for
  // the wrong concurrent requests.
  if (rule?.modifyResponseBody) {
    runResponsePipeline(req, res, proxy, target, rule, domain, config, logger, preBufferedRequestBody);
    return;
  }

  // Non-pipeline passthrough path.  Register per-request hooks on the shared proxy
  // only for this path (no modifyResponseBody means no concurrent pipeline racing).
  const onProxyReq = async (proxyReq: http.ClientRequest) => {
    if (rule?.onRequest) {
      try {
        const result = await rule.onRequest({
          req,
          proxyReq,
          res,
          domain,
          url: req.url ?? "",
        });
        if (result != null) {
          // onRequest returned a StaticResponse — short-circuit the upstream.
          // Write the response before destroying proxyReq to avoid a race with
          // the shared proxy's error handler writing a 502.
          sendStaticResponse(res, result);
          proxyReq.destroy();
          return;
        }
      } catch (err) {
        logger.error("onRequest hook error", {
          domain,
          error: (err as Error).message,
        });
      }
    }

    // Write the (possibly modified) request body when it was pre-buffered.
    if (preBufferedRequestBody !== null) {
      const contentType = Array.isArray(req.headers["content-type"])
        ? req.headers["content-type"][0]
        : req.headers["content-type"];
      const raw = preBufferedRequestBody.toString("utf-8");
      let modified: string | undefined;

      if (rule?.modifyRequestBody) {
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
          logger.error("modifyRequestBody error", {
            domain,
            error: (err as Error).message,
          });
        }
      }

      const buf = modified !== undefined ? Buffer.from(modified, "utf-8") : preBufferedRequestBody;
      proxyReq.setHeader("content-length", buf.length);
      proxyReq.removeHeader("transfer-encoding");
      proxyReq.end(buf);
    }
  };

  const onProxyRes = async (proxyRes: http.IncomingMessage) => {
    if (rule?.onResponse) {
      try {
        await rule.onResponse({ req, proxyRes, res, domain });
      } catch (err) {
        logger.error("onResponse hook error", {
          domain,
          error: (err as Error).message,
        });
      }
    }

    if (rule) {
      const elapsed = Date.now() - startTime;
      logger.info("← HTTP", {
        method: req.method,
        url: req.url,
        domain,
        status: proxyRes.statusCode,
        ms: elapsed,
      });
    }
  };

  proxy.once("proxyReq", onProxyReq);
  proxy.once("proxyRes", onProxyRes);
  proxy.web(req, res, { target });
}

