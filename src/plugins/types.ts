import type http from "node:http";
import type net from "node:net";

// ---------------------------------------------------------------------------
// Static response (short-circuit proxying)
// ---------------------------------------------------------------------------

/**
 * Return this from `onRequest` to immediately send a response to the client
 * without forwarding the request to the upstream at all.
 *
 * @example
 * onRequest(ctx) {
 *   if (ctx.url.includes('/blocked')) {
 *     return { status: 403, body: 'Forbidden', contentType: 'text/plain' };
 *   }
 * }
 */
export interface StaticResponse {
  /** HTTP status code. Default: `200`. */
  status?: number;
  /** Additional response headers. Merged with `contentType` if provided. */
  headers?: Record<string, string>;
  /** Response body string or Buffer. Default: empty. */
  body?: string | Buffer;
  /**
   * Shorthand for `Content-Type` header.
   * Ignored when `headers['content-type']` is already set.
   */
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Contexts passed into plugin hooks
// ---------------------------------------------------------------------------

export interface RequestContext {
  /** The original client request (incoming to the proxy). */
  req: http.IncomingMessage;
  /** The outgoing proxy request that will be sent to the upstream. */
  proxyReq: http.ClientRequest;
  /** The response object for the client connection. */
  res: http.ServerResponse;
  /** Normalised domain (after ignoreSubDomains stripping). */
  domain: string;
  /** Full requested URL from the client, e.g. http://example.com/path */
  url: string;
}

export interface ResponseContext {
  /** The original client request. */
  req: http.IncomingMessage;
  /** The response received from the upstream. */
  proxyRes: http.IncomingMessage;
  /** The response object for the client connection. */
  res: http.ServerResponse;
  /** Normalised domain. */
  domain: string;
}

export interface BodyContext extends ResponseContext {
  /** Content-Type of the upstream response. */
  contentType: string | undefined;
}

export interface ConnectContext {
  /** Raw TCP socket from the client. */
  socket: net.Socket;
  /** Requested CONNECT authority, e.g. "example.com:443". */
  authority: string;
  /** Normalised domain. */
  domain: string;
}

// ---------------------------------------------------------------------------
// Per-domain rule (plugin) contract
// ---------------------------------------------------------------------------

export interface RuleLogging {
  /** If true, log request headers and metadata for this domain. Default: inherits global. */
  enabled?: boolean;
  /** If true, capture request and response bodies (up to maxBodyBytes). */
  captureBody?: boolean;
}

export interface ProxyRule {
  /**
   * Upstream target. May be overridden per-request via `resolveTarget`.
   * Required unless `resolveTarget` dynamically resolves the target.
   */
  target?: string;

  /**
   * Dynamically compute the upstream target URL for each request.
   * Called before the request is forwarded; return value overrides `target`.
   * Return `undefined` to fall back to the static `target` or the default
   * passthrough behaviour.
   *
   * @example
   * resolveTarget(req, domain) {
   *   const path = req.url ?? '/';
   *   return path.startsWith('/v2') ? 'https://v2.api.internal' : 'https://v1.api.internal';
   * }
   */
  resolveTarget?: (
    req: http.IncomingMessage,
    domain: string,
  ) => string | undefined | Promise<string | undefined>;

  /**
   * Called before the request is forwarded.
   * You can modify proxyReq headers or **return a `StaticResponse`** to
   * short-circuit the proxy entirely — the upstream is never contacted and
   * the returned response is sent directly to the client.
   *
   * @example — intercept selectively
   * onRequest(ctx) {
   *   if (ctx.req.method === 'OPTIONS') {
   *     return { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
   *   }
   *   ctx.proxyReq.setHeader('X-Internal', '1');
   * }
   */
  onRequest?: (ctx: RequestContext) => void | StaticResponse | Promise<void | StaticResponse>;

  /**
   * Called when the upstream response arrives (headers available, body streaming).
   * You can modify response headers here.
   */
  onResponse?: (ctx: ResponseContext) => void | Promise<void>;

  /**
   * Called with the complete response body for text responses that are:
   * - Content-Type: text/... or application/json or application/xml
   * - Size ≤ global `maxBodyBytes`
   *
   * Return the (modified) body string, or undefined to leave it unchanged.
   */
  modifyResponseBody?: (body: string, ctx: BodyContext) => string | undefined | Promise<string | undefined>;

  /**
   * Called when a CONNECT tunnel is established (before TLS interception).
   * Useful for connection-level logging / blocking.
   */
  onConnect?: (ctx: ConnectContext) => void | Promise<void>;

  /**
   * Called when a WebSocket upgrade is established.
   */
  onWebSocketOpen?: (domain: string, req: http.IncomingMessage) => void;

  /**
   * Called when a WebSocket connection is closed.
   */
  onWebSocketClose?: (domain: string) => void;

  /** Per-rule logging overrides. */
  logging?: RuleLogging;

  /**
   * Plugin priority. Higher values are checked first when multiple rules
   * could match. Default: 0.
   */
  priority?: number;
}
