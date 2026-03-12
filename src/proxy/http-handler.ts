import type http from "node:http";
import type httpProxy from "http-proxy";
import type { PluginRegistry } from "../plugins/plugin-registry.ts";
import { extractHostname, normalizeHostname } from "../plugins/plugin-registry.ts";
import { getLogger } from "../logging/logger.ts";
import type { ProxyConfig } from "../config/schema.ts";
import type { CaAssets } from "../tls/ca-store.ts";
import type { StaticResponse } from "../plugins/types.ts";
import { runResponsePipeline } from "./response-pipeline.ts";

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

  // Pipeline path: runs on its own isolated proxy — do NOT register listeners on
  // the shared proxy here, otherwise stale `once` handlers accumulate and fire for
  // the wrong concurrent requests.
  if (rule?.modifyResponseBody) {
    runResponsePipeline(req, res, proxy, target, rule, domain, config, logger);
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

