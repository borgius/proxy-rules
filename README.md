# proxy-rules

A MITM-capable forward proxy with a JavaScript/TypeScript plugin system for per-domain request/response modification and logging. Runs on Node.js (v22+).

---

## Install

```bash
# Clone and install dependencies
git clone https://github.com/borgius/proxy-rules.git
cd proxy-rules
npm install

# Link the CLI globally
npm link
```

You can also install the published CLI from npm:

```bash
npm install -g proxy-rules
```

> `proxy-rules` requires **Node.js v22 or later** on your `PATH`.

---

## Commands

### `proxy-rules tls`

Creates a local Certificate Authority (CA) in `~/.proxy-rules/certs/` and attempts to install it into the system trust store so browsers trust HTTPS MITM traffic.

```bash
proxy-rules tls [--config <path>]
```

Run this once before starting the proxy for the first time.

### `proxy-rules serve`

Start the proxy server.

```bash
proxy-rules serve [--config <path>] [--rules <path>] [--port 8080] [--host 0.0.0.0]
```

---

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | auto-detect | Use a single config root directory and skip layered lookup |
| `--rules <path>` | auto-detect | Override only the rules directory |
| `--port <n>` | `8080` | Listening port |
| `--host <addr>` | `0.0.0.0` | Bind address |

---

## Config resolution

If you pass `--config`, that directory is used for config, rules, certs, and other generated files exactly as before.

Without `--config`, `proxy-rules` now resolves config in layers:

1. `~/.proxy-rules`
2. `<git-root>/.proxy-rules` (if the current working directory is inside a git repo and that folder exists)

Settings from the project-local `config.json` override the global file, while generated TLS assets continue to live under `~/.proxy-rules/certs/` by default. This makes it easy to keep shared certs in your home directory and version project-specific rules inside the repository.

If you pass `--rules`, only the rules directory changes; config merging and cert storage keep using the normal resolution rules.

HTTPS interception is now rule-driven too: domains without a matching rule are tunneled through untouched, so the browser sees the real site certificate. A hostname-specific leaf cert is generated only when a rule requires HTTPS interception. The trusted root CA remains the trust anchor; it cannot replace per-host certificates for intercepted domains.

Example layout:

```text
~/.proxy-rules/
├── config.json          # shared defaults + TLS settings
└── certs/

my-project/
├── .git/
└── .proxy-rules/
  ├── config.json      # project-specific overrides
  └── rules/
```

---

## Config directory layout

```
~/.proxy-rules/
├── config.json          # Global config (see below)
├── rules/               # Per-domain plugin folders
│   ├── example.com/
│   │   └── index.js     # Rule plugin for example.com
│   └── api.acme.org/
│       ├── rewrite.js   # Composes into a multi-module plugin
│       └── logging.js
├── certs/               # Generated CA + per-domain leaf certs
│   ├── ca-cert.pem
│   ├── ca-key.pem
│   └── domains/
└── logs/                # Optional structured JSON logs
```

### `config.json`

```json
{
  "port": 8080,
  "host": "0.0.0.0",
  "ignoreSubDomains": ["www"],
  "logging": {
    "level": "info",
    "format": "json",
    "outputPath": "~/.proxy-rules/logs/proxy.log",
    "maxBodyBytes": 4096
  },
  "pluginHotReload": true
}
```

---

## Rule plugins

A rule plugin is a JavaScript file (or `index.js` in a folder) that exports a default `ProxyRule` object. TypeScript files are also supported when running via `vite-node` (`npm run dev`). Rules are matched by normalising the requested hostname (stripping configured `ignoreSubDomains` entries like `www`) and looking up a matching folder under the active rules directory (`--rules`, `<git-root>/.proxy-rules/rules`, or `~/.proxy-rules/rules`).

### Minimal example

```javascript
// ~/.proxy-rules/rules/example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://example.com',
};

export default rule;
```

### Request/response hooks

```javascript
// ~/.proxy-rules/rules/api.example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  onRequest(ctx) {
    ctx.proxyReq.setHeader('X-Custom', 'value');
  },

  onResponse(ctx) {
    ctx.proxyRes.headers['x-proxied-by'] = 'proxy-rules';
  },

  // Body mutation — only called for text responses ≤ maxBodyBytes
  modifyResponseBody(body, ctx) {
    return body.replace('hello', 'world');
  },

  logging: { captureBody: true },
};

export default rule;
```

### Context helpers

`ResponseContext` (available in `onResponse` and `modifyResponseBody`) exposes a `helpers` object with four utility methods for debugging and inspection:

| Method | Description |
|---|---|
| `helpers.toCurl(req)` | Returns a ready-to-run `curl -v` command for the request |
| `helpers.toCurl(req, proxyRes)` | Same, plus `curl -v`-style `> request` / `< response` header trace. When bodies are stored on the objects (set automatically by the pipeline), they are included. JSON is pretty-printed, text is raw, binary is base64. Output is truncated at 200 lines. |
| `helpers.toFetch(req)` | Returns `{ url, options }` ready to pass to `fetch()` |
| `helpers.toJson(req\|res)` | Serialises a request or response to a plain JSON-able object |
| `helpers.saveTo(path, data)` | Writes a string or object (pretty-printed JSON) to a file; creates parent dirs |

```javascript
// ~/.proxy-rules/rules/api.example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  async onResponse(ctx) {
    // Dump the raw curl command to reproduce this request from a terminal
    console.log(ctx.helpers.toCurl(ctx.req));

    // Log the full verbose trace (request + response headers)
    console.log(ctx.helpers.toCurl(ctx.req, ctx.proxyRes));

    // Save a JSON snapshot of the response for offline inspection
    await ctx.helpers.saveTo('/tmp/debug/response.json', ctx.helpers.toJson(ctx.proxyRes));
  },

  async modifyResponseBody(body, ctx) {
    // Full verbose trace — request and response bodies are attached automatically
    // by the pipeline, so no need to pass them explicitly
    console.log(ctx.helpers.toCurl(ctx.req, ctx.proxyRes));

    // ctx also has helpers (via BodyContext → ResponseContext)
    await ctx.helpers.saveTo('/tmp/debug/body.json', ctx.helpers.toJson(ctx.req));
    return body;
  },
};

export default rule;
```

### Returning a static response (short-circuit)

Return a `StaticResponse` object from `onRequest` to answer the client immediately without forwarding the request to the upstream at all.

```javascript
// ~/.proxy-rules/rules/api.example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  onRequest(ctx) {
    // Block /admin paths — upstream is never contacted.
    if (ctx.url.includes('/admin')) {
      return {
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }

    // No return value → request is forwarded normally.
    ctx.proxyReq.setHeader('X-Forwarded-Via', 'proxy-rules');
  },
};

export default rule;
```

When `onRequest` returns nothing (or `undefined`), the request is forwarded as usual.

#### `StaticResponse` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `status` | `number` | `200` | HTTP status code |
| `headers` | `Record<string, string>` | `{}` | Additional response headers |
| `body` | `string \| Buffer` | `""` | Response body |
| `contentType` | `string` | — | Shorthand for `Content-Type`; ignored when `headers['content-type']` is already set |

### Modifying the request body

`modifyRequestBody` mirrors `modifyResponseBody` for outgoing requests. Receive the full buffered body as a string and return the modified version (or `undefined` to leave it unchanged). Works for POST / PUT / PATCH requests whose size is ≤ `maxBodyBytes`. The proxy handles all buffering and re-sending.

```javascript
// ~/.proxy-rules/rules/api.example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  target: 'https://api.example.com',

  /**
   * @param {string} body
   * @param {import('proxy-rules/types').RequestBodyContext} ctx
   */
  modifyRequestBody(body, ctx) {
    if (!ctx.contentType?.includes('application/json')) return undefined;

    const json = JSON.parse(body);
    json._env = 'intercepted';
    delete json.clientSecret;
    return JSON.stringify(json);
  },
};

export default rule;
```

`modifyRequestBody` and `modifyResponseBody` can coexist in the same rule — the proxy runs both.

### Dynamic upstream target

Implement `resolveTarget` to choose the upstream URL per-request. It runs **before** the connection is opened, so the chosen URL is used for the actual TCP/TLS handshake.

```javascript
// ~/.proxy-rules/rules/gateway.example.com/index.js

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  // Fallback when resolveTarget returns undefined.
  target: 'https://api.example.com',

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {string} domain
   * @returns {string | undefined}
   */
  resolveTarget(req, domain) {
    // Route /v2 paths to a separate backend.
    if (req.url?.startsWith('/v2')) {
      return 'https://v2.api.internal';
    }
    // Return undefined → keep the static `target` above.
  },
};

export default rule;
```

`resolveTarget` may also be `async` for database/service-discovery lookups.

### Multi-module domains

If a domain folder contains multiple `.js` (or `.ts`) files, **all** exported `ProxyRule` objects are composed in filename alphabetical order. Later files can override or extend earlier ones.

---

## Examples

The [`examples/`](examples/) directory contains ready-to-use rules covering the most common patterns:

| Example | What it shows |
|---|---|
| [`mock-api.example.com`](examples/rules/mock-api.example.com/index.js) | Full static mock — upstream never called |
| [`maintenance.example.com`](examples/rules/maintenance.example.com/index.js) | 503 maintenance page |
| [`api.example.com`](examples/rules/api.example.com/index.js) | Selective 403 block + header injection |
| [`gateway.example.com`](examples/rules/gateway.example.com/index.js) | Path-based routing to different backends |
| [`shop.example.com`](examples/rules/shop.example.com/index.js) | A/B canary traffic splitting |
| [`cors.example.com`](examples/rules/cors.example.com/index.js) | Local OPTIONS preflight handler |
| [`headers.example.com`](examples/rules/headers.example.com/index.js) | Add, override, and remove **request headers** |
| [`payload.example.com`](examples/rules/payload.example.com/index.js) | Mutate **request body** (JSON / form) via `modifyRequestBody` |
| [`resp-headers.example.com`](examples/rules/resp-headers.example.com/index.js) | Inject security headers and rewrite **response headers** |
| [`resp-body.example.com`](examples/rules/resp-body.example.com/index.js) | Rewrite **response body** — JSON, HTML, plain text, JS |

See [`examples/README.md`](examples/README.md) for detailed explanations and copy-paste instructions.

---

## Client setup

Configure your browser or system proxy to point at `http://127.0.0.1:8080`.

For `curl`:
```bash
curl -x http://127.0.0.1:8080 https://example.com
```

---

## TLS trust caveats

- The generated CA is stored in `~/.proxy-rules/certs/ca-cert.pem`.
- On macOS, `proxy-rules tls` attempts to add it to the System keychain via `security add-trusted-cert`. If that fails (e.g. missing `sudo` or SIP), the command prints exact manual instructions.
- You must set the certificate to **Always Trust** for TLS in Keychain Access.
- iOS/Android devices require their own manual trust installation.
- HTTP/2 (ALPN negotiation to h2) is not intercepted; only HTTP/1.1 traffic is modified.

---

## Known limits

- HTTP/2 MITM not supported in v1.
- WebSocket frame-level content rewriting is not supported; only lifecycle events are exposed.
- Binary responses bypass body mutation hooks regardless of size.
- Large text responses exceeding `maxBodyBytes` pass through unmodified.

---

## Release workflow

The repo includes a release command that:

1. verifies the git working tree is clean,
2. runs tests and type-checking,
3. bumps the package version,
4. builds the publishable `dist/` output,
5. publishes the package to npm,
6. creates a git commit + tag, and
7. pushes the release commit and tag to GitHub.

Before the first publish, authenticate with npm:

```bash
npm login
```

Then run one of the standard semver bumps:

```bash
npm run release -- patch
npm run release -- minor
npm run release -- major
```

---

## License

MIT
