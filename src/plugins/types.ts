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
// Shared helper utilities injected into response contexts
// ---------------------------------------------------------------------------

export interface ContextHelpers {
  /**
   * Converts a request to a `curl -v` command string.
   * When `res` is supplied the output also shows response headers in `curl -v` style (`>` / `<` lines).
   * Bodies are read automatically from `_body` properties set on the objects by the pipeline:
   * - JSON bodies are pretty-printed; text bodies are printed as-is; binary bodies are base64-encoded.
   * - Text and base64 output is truncated at 200 lines.
   *
   * @example
   * console.log(ctx.helpers.toCurl(ctx.req));
   * // verbose with response headers + bodies (bodies included automatically in modifyResponseBody)
   * console.log(ctx.helpers.toCurl(ctx.req, ctx.proxyRes));
   */
  toCurl(
    req: http.IncomingMessage,
    res?: http.IncomingMessage | http.ServerResponse,
  ): string;

  /**
   * Converts a request to a fetch-compatible `{ url, options }` pair.
   *
   * @example
   * const { url, options } = ctx.helpers.toFetch(ctx.req);
   * const resp = await fetch(url, options);
   */
  toFetch(req: http.IncomingMessage): { url: string; options: { method: string; headers: Record<string, string> } };

  /**
   * Serialises a request or response to a plain JSON-friendly object.
   *
   * @example
   * console.log(JSON.stringify(ctx.helpers.toJson(ctx.req), null, 2));
   * console.log(JSON.stringify(ctx.helpers.toJson(ctx.proxyRes), null, 2));
   */
  toJson(reqOrRes: http.IncomingMessage | http.ServerResponse): Record<string, unknown>;

  /**
   * Saves `data` to `filePath`. Strings are written as-is; objects are JSON-pretty-printed (2 spaces).
   * Parent directories are created automatically.
   *
   * @example
   * await ctx.helpers.saveTo('/tmp/debug/req.json', ctx.helpers.toJson(ctx.req));
   * await ctx.helpers.saveTo('/tmp/debug/response.txt', ctx.helpers.toCurl(ctx.req, ctx.proxyRes));
   */
  saveTo(filePath: string, data: string | object): Promise<void>;
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
  /** Utility helpers for inspecting and saving requests/responses. */
  helpers: ContextHelpers;
}

export interface BodyContext extends ResponseContext {
  /** Content-Type of the upstream response. */
  contentType: string | undefined;
}

export interface RequestBodyContext {
  /** The original client request. */
  req: http.IncomingMessage;
  /** The outgoing proxy request that will be sent to the upstream. */
  proxyReq: http.ClientRequest;
  /** The response object for the client connection. */
  res: http.ServerResponse;
  /** Normalised domain. */
  domain: string;
  /** Full requested URL from the client, e.g. http://example.com/path */
  url: string;
  /** Content-Type of the incoming request body, if present. */
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

export type OnRequestHandler =
  | ((ctx: RequestContext) => StaticResponse | undefined)
  | ((ctx: RequestContext) => void)
  | ((ctx: RequestContext) => Promise<StaticResponse | undefined>)
  | ((ctx: RequestContext) => Promise<void>);

export type ProxyRuleMatchFn = (
  url: string,
  req: http.IncomingMessage,
) => boolean | Promise<boolean>;

export type ProxyRuleMatch = string | RegExp | ProxyRuleMatchFn;

// ---------------------------------------------------------------------------
// Per-domain rule (plugin) contract
// ---------------------------------------------------------------------------

export interface RuleLogging {
  /** If true, log request headers and metadata for this domain. Default: inherits global. */
  enabled?: boolean;
  /**
   * If true, capture request and response bodies.
   * When the global `maxBodyBytes` is disabled or very small, body hooks use a sane
   * per-rule fallback ceiling so capture-focused rules can still inspect typical API payloads.
   */
  captureBody?: boolean;
}

export interface ProxyRule {
  /**
   * Optional HTTP matcher for rules discovered from `rules/global`.
   *
   * Supported variants:
   * - string: matched later against the full request URL
   * - RegExp: tested against the full request URL
   * - function: receives `(url, req)` and returns a boolean, sync or async
   *
   * This property is ignored for normal `rules/<domain>` rules.
   */
  match?: ProxyRuleMatch;

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
    * Returning nothing (or `undefined`) continues normal proxying.
   *
   * @example — intercept selectively
   * onRequest(ctx) {
   *   if (ctx.req.method === 'OPTIONS') {
   *     return { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
   *   }
   *   ctx.proxyReq.setHeader('X-Internal', '1');
   * }
   */
  onRequest?: OnRequestHandler;

  /**
   * Called with the complete request body before it is forwarded to the upstream.
   * Works for requests carrying a body (POST / PUT / PATCH) whose size is ≤ `maxBodyBytes`.
   *
   * Return the (modified) body string, or `undefined` to forward the original body unchanged.
   * The proxy handles buffering and re-sending — you do not need to manage `req.pipe` or
   * `proxyReq.end()` yourself.
   *
   * @example
   * modifyRequestBody(body, ctx) {
   *   const json = JSON.parse(body);
   *   delete json.internalDebugFlag;
   *   return JSON.stringify(json);
   * }
   */
  modifyRequestBody?: (body: string, ctx: RequestBodyContext) => string | undefined | Promise<string | undefined>;

  /**
   * Called when the upstream response arrives (headers available, body streaming).
   * You can modify response headers here.
   */
  onResponse?: (ctx: ResponseContext) => void | Promise<void>;

  /**
   * Called with the complete response body for text responses that are:
   * - Content-Type: text/... or application/json or application/xml
    * - Size ≤ the effective body capture limit (`maxBodyBytes`, or a per-rule capture fallback)
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
