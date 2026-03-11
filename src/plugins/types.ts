import type http from "node:http";
import type net from "node:net";

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
   * Upstream target. May be overridden per-request from onRequest.
   * Required unless onRequest dynamically resolves the target.
   */
  target?: string;

  /**
   * Called before the request is forwarded.
   * You can modify proxyReq headers, abort the request, etc.
   */
  onRequest?: (ctx: RequestContext) => void | Promise<void>;

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
