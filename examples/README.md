# Rule Examples

Ready-to-use rule examples demonstrating the two main interception capabilities:

| Capability | How to use | When the upstream is contacted |
|---|---|---|
| **Static response** | Return a `StaticResponse` from `onRequest` | Never — response goes straight to the client |
| **Dynamic target** | Implement `resolveTarget` | Always — but at the URL you choose |
| **HTTP-global URL matching** | Put a rule under `rules/global` and set `match` | Depends on the composed global/domain rules |

---

## Examples at a glance

| Folder | What it shows |
|---|---|
| [`mock-api.example.com`](rules/mock-api.example.com/index.js) | Always return a hard-coded JSON body; upstream is never called |
| [`maintenance.example.com`](rules/maintenance.example.com/index.js) | Serve a 503 HTML maintenance page unconditionally |
| [`api.example.com`](rules/api.example.com/index.js) | Block specific paths with 403; forward everything else |
| [`gateway.example.com`](rules/gateway.example.com/index.js) | Route requests to different backends based on URL path |
| [`global/path-prefix.js`](rules/global/path-prefix.js) | Match every `/v1/` URL across hosts and compose with any matching domain rule |
| [`shop.example.com`](rules/shop.example.com/index.js) | A/B split — send 20 % of traffic to a canary backend |
| [`cors.example.com`](rules/cors.example.com/index.js) | Handle `OPTIONS` preflight locally; forward real requests |
| [`headers.example.com`](rules/headers.example.com/index.js) | Add, override, and remove **request headers** before forwarding |
| [`payload.example.com`](rules/payload.example.com/index.js) | Mutate **request body** (JSON / form) via `modifyRequestBody` |
| [`resp-headers.example.com`](rules/resp-headers.example.com/index.js) | Inject security headers and rewrite **response headers** |
| [`resp-body.example.com`](rules/resp-body.example.com/index.js) | Rewrite **response body** — JSON, HTML, plain text, and JS |

---

## Choosing a global rule vs. a domain rule

Use a **global rule** when the trigger is about the request URL pattern and should work across multiple hosts.
Use a **domain rule** when the behavior belongs to one hostname, one backend, or one host-specific policy.

| Choose this | When it fits best |
|---|---|
| `rules/global/<name>.js` | You want one HTTP rule to apply across many hosts, gated by URL matching |
| `rules/<domain>/index.js` | You want host-specific targeting, blocking, headers, or body mutation |

Global rules are HTTP-only and run **before** the resolved domain rule for that request. The domain rule runs last, so it can still override `target`, `resolveTarget`, and logging settings, or short-circuit in `onRequest`.

### Coexistence example: `global/path-prefix.js` + `api.example.com`

The example in [`rules/global/path-prefix.js`](rules/global/path-prefix.js) uses a string matcher (`match: '/v1/'`) to tag any matching HTTP request, regardless of host. Pair it with [`rules/api.example.com/index.js`](rules/api.example.com/index.js) to see both scopes working together:

- Requests like `http://api.example.com/v1/users` match the global rule first, then the `api.example.com` domain rule.
- The global rule adds a cross-cutting marker header/response header for `/v1/` traffic.
- The domain rule still applies its host-specific behavior afterwards.
- If the domain rule returns a `StaticResponse`, composition stops there and the upstream is skipped.

Supported on-disk layouts for the global side are:

```text
~/.proxy-rules/rules/global/path-prefix.js
~/.proxy-rules/rules/global/path-prefix/index.js
```

---

## Static response — returning from `onRequest`

Return a [`StaticResponse`](../../src/plugins/types.ts) object from `onRequest` to short-circuit the proxy. The upstream is **never contacted**.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  onRequest(ctx) {
    // Any truthy return value is treated as a StaticResponse.
    return {
      status: 200,                          // default: 200
      contentType: "application/json",      // shorthand for Content-Type header
      headers: { "X-Mocked-By": "proxy-rules" },
      body: JSON.stringify({ ok: true }),
    };
  },
};

export default rule;
```

**Selective interception** — return `undefined` (or nothing) to forward the request normally:

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://api.example.com",

  onRequest(ctx) {
    if (ctx.req.method === "OPTIONS") {
      // Short-circuit OPTIONS preflight
      return { status: 204, headers: { "Access-Control-Allow-Origin": "*" } };
    }
    // All other methods are forwarded.
    ctx.proxyReq.setHeader("X-Request-Id", crypto.randomUUID());
  },
};
```

### `StaticResponse` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `status` | `number` | `200` | HTTP status code |
| `headers` | `Record<string,string>` | `{}` | Additional response headers |
| `body` | `string \| Buffer` | `""` | Response body |
| `contentType` | `string` | — | Shorthand for `Content-Type`; ignored when `headers['content-type']` is already set |

---

## Dynamic target — `resolveTarget`

Implement `resolveTarget` to pick the upstream URL on a per-request basis. It runs **before** the connection to the upstream is opened.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  // Fallback when resolveTarget returns undefined.
  target: "https://api.example.com",

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {string} domain
   * @returns {string | undefined}
   */
  resolveTarget(req, domain) {
    // Route /v2 paths to a different backend.
    if (req.url?.startsWith("/v2")) {
      return "https://v2.api.internal";
    }
    // Return undefined → use the static `target` above.
  },
};
```

`resolveTarget` can also be **`async`** for cases that require a database or service-discovery lookup:

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  async resolveTarget(req) {
    const tenant = req.headers["x-tenant-id"];
    const backend = await lookupBackend(tenant); // async DB / cache call
    return backend ?? "https://default.api.internal";
  },
};
```

### Combining both capabilities

You can use `resolveTarget` and a selective static response together in the same rule:

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: "https://api.example.com",

  resolveTarget(req) {
    // Route by path — the chosen target is used unless onRequest intercepts.
    return req.url?.startsWith("/legacy") ? "https://legacy.api.internal" : undefined;
  },

  onRequest(ctx) {
    // Block deprecated endpoint regardless of which backend was chosen.
    if (ctx.url.includes("/deprecated")) {
      return { status: 410, body: "Gone", contentType: "text/plain" };
    }
    ctx.proxyReq.setHeader("X-Via", "proxy-rules");
  },
};
```

---

## Request header manipulation — `onRequest`

All header operations go through `ctx.proxyReq` (a `http.ClientRequest`).
Return value is ignored here — return nothing and the request is forwarded.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  onRequest(ctx) {
    const { proxyReq, req } = ctx;

    // Add a new header
    proxyReq.setHeader('X-Internal-Token', process.env.INTERNAL_TOKEN);

    // Override an existing header
    proxyReq.setHeader('User-Agent', 'my-service/1.0');

    // Remove a header — stops it reaching the upstream
    proxyReq.removeHeader('Cookie');
    proxyReq.removeHeader('Referer');

    // Forward real client IP
    proxyReq.setHeader('X-Forwarded-For', req.socket.remoteAddress ?? '');
  },
};
```

See the full example in [`headers.example.com`](rules/headers.example.com/index.js).

---

## Request body (payload) modification — `modifyRequestBody`

`modifyRequestBody` mirrors `modifyResponseBody` for the request side. Receive the full buffered body as a string, return the modified version (or `undefined` to leave it unchanged). Works for POST / PUT / PATCH requests whose size is ≤ `maxBodyBytes`.

The proxy handles all buffering and re-sending — no `req.pipe` tricks needed.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  /**
   * @param {string} body
   * @param {import('proxy-rules/types').RequestBodyContext} ctx
   */
  modifyRequestBody(body, ctx) {
    if (!ctx.contentType?.includes('application/json')) return undefined;

    let json;
    try { json = JSON.parse(body); }
    catch { return undefined; }  // invalid JSON — leave unchanged

    // Inject, strip, rename as needed.
    json._proxyTimestamp = Date.now();
    delete json.internalDebugFlag;

    return JSON.stringify(json);
  },
};
```

You can use `modifyRequestBody` and `modifyResponseBody` together in the same rule:

```javascript
const rule = {
  modifyRequestBody(body, ctx) {
    // Rewrite the outgoing request body
    return body.replace('staging', 'production');
  },

  modifyResponseBody(body, ctx) {
    // Rewrite the incoming response body
    return body.replace('internal-host', 'api.example.com');
  },
};
```

> **Note** If you need low-level control (e.g. manipulating raw bytes, form data, or non-UTF-8 content),
> you can still implement the manual pattern in `onRequest` — see the source of
> [`payload.example.com`](rules/payload.example.com/index.js) for the old approach as a reference,
> or look at the JSDoc on `onRequest`.

See the full example (JSON + URL-encoded forms) in [`payload.example.com`](rules/payload.example.com/index.js).

---

## Response header manipulation — `onResponse`

`onResponse` fires when the upstream response headers arrive (before the body
streams to the client). Mutate `ctx.proxyRes.headers` in place.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  onResponse(ctx) {
    const { proxyRes } = ctx;

    // Inject security headers
    proxyRes.headers['strict-transport-security'] = 'max-age=31536000';
    proxyRes.headers['x-content-type-options']    = 'nosniff';
    proxyRes.headers['x-frame-options']            = 'DENY';

    // Override a specific header value
    proxyRes.headers['cache-control'] = 'no-store';

    // Remove headers that expose internal stack details
    delete proxyRes.headers['server'];
    delete proxyRes.headers['x-powered-by'];
  },
};
```

See the full example (CORS rewriting, TTL shortening, infrastructure header scrubbing) in [`resp-headers.example.com`](rules/resp-headers.example.com/index.js).

---

## Response body modification — `modifyResponseBody`

`modifyResponseBody` receives the fully-buffered response body as a string.
Return the modified string, or `undefined` to leave it unchanged.

The proxy only calls this hook for **text-like** responses
(`text/*`, `application/json`, `application/xml`, `application/javascript`)
whose size is ≤ `config.logging.maxBodyBytes`.

```javascript
/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  modifyResponseBody(body, ctx) {
    if (!ctx.contentType?.includes('application/json')) return undefined;

    let json;
    try { json = JSON.parse(body); }
    catch { return undefined; }  // invalid JSON — leave unchanged

    // Inject a field
    json._proxied = true;

    // Mask a sensitive value
    if (json.user?.ssn) {
      json.user.ssn = '***-**-' + String(json.user.ssn).slice(-4);
    }

    return JSON.stringify(json);
  },
};
```

You can also use `onResponse` alongside `modifyResponseBody` in the same rule —
`onResponse` runs first (letting you rewrite headers), then the body hook fires:

```javascript
const rule = {
  onResponse(ctx) {
    // Runs first — modify headers
    delete ctx.proxyRes.headers['x-internal-trace-id'];
  },

  modifyResponseBody(body, ctx) {
    // Runs second — modify body
    return body.replace(/staging\.example\.com/g, 'example.com');
  },
};
```

See the full example (JSON masking, HTML injection, JS feature-flag patching) in [`resp-body.example.com`](rules/resp-body.example.com/index.js).

---

## Usage

Copy any example folder into your active rules directory:

```bash
cp -r examples/rules/mock-api.example.com ~/.proxy-rules/rules/
```

For a global rule, copy it into the reserved `global/` namespace:

```bash
mkdir -p ~/.proxy-rules/rules/global
cp examples/rules/global/path-prefix.js ~/.proxy-rules/rules/global/path-prefix.js
```

To try the coexistence example, copy both the global rule and a domain rule:

```bash
mkdir -p ~/.proxy-rules/rules/global
cp examples/rules/global/path-prefix.js ~/.proxy-rules/rules/global/path-prefix.js
cp -r examples/rules/api.example.com ~/.proxy-rules/rules/
```

Then start (or hot-reload) the proxy:

```bash
proxy-rules serve
```

Because hot-reload is enabled by default, changes to rule files take effect immediately without restarting.
