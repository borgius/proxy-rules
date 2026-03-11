# proxy-rules

A MITM-capable forward proxy with a TypeScript plugin system for per-domain request/response modification and logging. Built with Bun.

---

## Install

```bash
# Clone and install dependencies
git clone https://github.com/borgius/proxy-rules.git
cd proxy-rules
bun install

# Link the CLI globally
bun link
```

You can also install the published CLI from npm once Bun is available on your machine:

```bash
bun install -g proxy-rules
```

> `proxy-rules` executes with Bun at runtime, so make sure `bun` is installed and on your `PATH`.

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
│   │   └── index.ts     # Rule plugin for example.com
│   └── api.acme.org/
│       ├── rewrite.ts   # Composes into a multi-module plugin
│       └── logging.ts
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

A rule plugin is a TypeScript file (or `index.ts` in a folder) that exports a default `ProxyRule` object. Rules for a domain are matched by normalising the requested hostname (stripping configured `ignoreSubDomains` entries like `www`) and looking up a matching folder under the active rules directory (`--rules`, `<git-root>/.proxy-rules/rules`, or `~/.proxy-rules/rules`).

### Minimal example

```typescript
// ~/.proxy-rules/rules/example.com/index.ts
import type { ProxyRule } from 'proxy-rules/types';

const rule: ProxyRule = {
  target: 'https://example.com',
};

export default rule;
```

### Request/response hooks

```typescript
import type { ProxyRule } from 'proxy-rules/types';

const rule: ProxyRule = {
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

### Multi-module domains

If a domain folder contains multiple `.ts` files, **all** exported `ProxyRule` objects are composed in filename alphabetical order. Later files can override or extend earlier ones.

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
