/**
 * End-to-end pipeline integration tests.
 *
 * These tests spin up a real HTTP proxy server backed by our actual
 * handleHttpRequest / runResponsePipeline stack and make live requests to
 * https://dummyjson.com — no mocking at all.
 *
 * Each test:
 *  1. Fetches https://dummyjson.com/products directly (baseline).
 *  2. Fetches the same URL routed through our local proxy with a rule that has
 *     modifyResponseBody set.
 *  3. Asserts the expected behaviour (identity passthrough vs. mutation).
 */

import { describe, expect, test } from "vitest";
import http from "node:http";
import type net from "node:net";
import { initLogger } from "../src/logging/logger.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
import type { DiscoveredPlugin } from "../src/plugins/discover-plugins.ts";
import { createProxyServer } from "../src/proxy/create-http-proxy.ts";
import { handleHttpRequest } from "../src/proxy/http-handler.ts";
import type { ProxyConfig } from "../src/config/schema.ts";
import type { ProxyRule } from "../src/plugins/types.ts";

// ---------------------------------------------------------------------------
// Shared config — body logging off to keep things simple
// ---------------------------------------------------------------------------

const config: ProxyConfig = {
  port: 0,
  host: "127.0.0.1",
  ignoreSubDomains: ["www"],
  logging: { level: "error", format: "pretty", maxBodyBytes: 0 },
  pluginHotReload: false,
  upstreamTimeout: 30_000,
};

initLogger(config.logging);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a proxy and run `fn(port)`, then shut the server down. */
async function withProxy(
  rule: ProxyRule,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const registry = new PluginRegistry(config.ignoreSubDomains);
  registry.replace([{ domain: "dummyjson.com", rule }]);

  return withProxyPlugins(registry, fn);
}

async function withProxyPlugins(
  registry: PluginRegistry,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const proxy = createProxyServer();
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, proxy, registry, config);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function withDiscoveredPlugins(
  plugins: DiscoveredPlugin[],
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const registry = new PluginRegistry(config.ignoreSubDomains);
  registry.replace(plugins);

  return withProxyPlugins(registry, fn);
}

async function withUpstream(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/**
 * Send a plain HTTP request to our local proxy.
 * The proxy looks up the `host` header in the registry, applies the rule, and
 * forwards the request to the upstream HTTPS target transparently.
 */
async function requestThroughProxy(
  proxyPort: number,
  options: {
    host: string;
    path: string;
    method?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: options.path,
        method: options.method ?? "GET",
        headers: {
          host: options.host,
          // Ask for uncompressed response so we can compare the body as text.
          // The pipeline also injects this header but belt-and-suspenders here.
          "accept-encoding": "identity",
          ...(body ? { "content-length": Buffer.byteLength(body, "utf8") } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("response pipeline — live dummyjson.com", () => {
  // ── Test 1: Passthrough ──────────────────────────────────────────────────

  test(
    "returns identical JSON when modifyResponseBody passes body through unchanged",
    async () => {
      // 1. Baseline — fetch directly from dummyjson (no proxy)
      const directRes = await fetch("https://dummyjson.com/products", {
        headers: { "accept-encoding": "identity" },
      });
      expect(directRes.ok).toBe(true);
      const directJson = (await directRes.json()) as unknown;

      // 2. Same request routed through our proxy with a no-op modifier
      await withProxy(
        {
          target: "https://dummyjson.com",
          modifyResponseBody(body) {
            return body; // identity — do not touch the body
          },
        },
        async (proxyPort) => {
          const { status, headers, body: proxyBody } = await requestThroughProxy(
            proxyPort,
            { host: "dummyjson.com", path: "/products" },
          );

          expect(status).toBe(200);

          // content-length must match the actual byte size of the body we received
          expect(Number(headers["content-length"])).toBe(Buffer.byteLength(proxyBody, "utf8"));

          // Result must parse as valid JSON
          const proxyJson = JSON.parse(proxyBody) as unknown;

          // Must be structurally identical to a direct fetch
          expect(proxyJson).toEqual(directJson);
        },
      );
    },
    30_000,
  );

  // ── Test 2: Body mutation ────────────────────────────────────────────────

  test(
    "modifyResponseBody can mutate live JSON and result is structurally valid",
    async () => {
      await withProxy(
        {
          target: "https://dummyjson.com",
          modifyResponseBody(body) {
            const data = JSON.parse(body) as {
              products: Array<Record<string, unknown>>;
            };
            // Zero out every price and stamp each product
            data.products = data.products.map((p) => ({
              ...p,
              price: 0,
              proxied: true,
            }));
            return JSON.stringify(data);
          },
        },
        async (proxyPort) => {
          const { status, headers, body } = await requestThroughProxy(
            proxyPort,
            { host: "dummyjson.com", path: "/products" },
          );

          expect(status).toBe(200);

          // Must be valid JSON
          const data = JSON.parse(body) as {
            products: Array<{ price: number; proxied: boolean }>;
          };

          expect(Array.isArray(data.products)).toBe(true);
          expect(data.products.length).toBeGreaterThan(0);

          for (const product of data.products) {
            expect(product.price).toBe(0);
            expect(product.proxied).toBe(true);
          }

          // content-length must reflect the mutated body size, not the original
          expect(Number(headers["content-length"])).toBe(Buffer.byteLength(body, "utf8"));
        },
      );
    },
    30_000,
  );
});

describe("response pipeline — effective HTTP rule integration", () => {
  test("runs matched global and domain hooks in order on the passthrough branch", async () => {
    const events: string[] = [];

    await withUpstream(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
      async (upstreamPort) => {
        await withDiscoveredPlugins(
          [
            {
              kind: "global",
              name: "audit",
              rule: {
                match: "/passthrough",
                target: `http://127.0.0.1:${upstreamPort}`,
                onRequest(ctx) {
                  events.push(`global:onRequest:${ctx.url}`);
                  ctx.proxyReq.setHeader("x-global", "1");
                  return undefined;
                },
                onResponse() {
                  events.push("global:onResponse");
                },
              },
            },
            {
              kind: "domain",
              domain: "api.example.com",
              rule: {
                target: `http://127.0.0.1:${upstreamPort}`,
                onRequest(ctx) {
                  events.push(`domain:onRequest:${ctx.url}`);
                  ctx.proxyReq.setHeader("x-domain", "1");
                  return undefined;
                },
                onResponse() {
                  events.push("domain:onResponse");
                },
              },
            },
          ],
          async (proxyPort) => {
            const response = await requestThroughProxy(proxyPort, {
              host: "api.example.com",
              path: "/passthrough?x=1",
            });

            expect(response.status).toBe(200);
            expect(response.body).toBe("ok");
          },
        );
      },
    );

    expect(events).toEqual([
      "global:onRequest:http://api.example.com/passthrough?x=1",
      "domain:onRequest:http://api.example.com/passthrough?x=1",
      "global:onResponse",
      "domain:onResponse",
    ]);
  });

  test("passes the same composed rule and absolute URL into the response pipeline branch", async () => {
    const events: string[] = [];

    await withUpstream(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`upstream:${Buffer.concat(chunks).toString("utf8")}`);
        });
      },
      async (upstreamPort) => {
        await withDiscoveredPlugins(
          [
            {
              kind: "global",
              name: "audit",
              rule: {
                match: "/pipeline",
                target: `http://127.0.0.1:${upstreamPort}`,
                onRequest(ctx) {
                  events.push(`global:onRequest:${ctx.url}`);
                  return undefined;
                },
                modifyRequestBody(body, ctx) {
                  events.push(`global:modifyRequestBody:${ctx.url}`);
                  return `${body}|global:${ctx.url}`;
                },
                modifyResponseBody(body) {
                  events.push("global:modifyResponseBody");
                  return `${body}|global`;
                },
                onResponse() {
                  events.push("global:onResponse");
                },
              },
            },
            {
              kind: "domain",
              domain: "api.example.com",
              rule: {
                target: `http://127.0.0.1:${upstreamPort}`,
                onRequest(ctx) {
                  events.push(`domain:onRequest:${ctx.url}`);
                  return undefined;
                },
                modifyRequestBody(body, ctx) {
                  events.push(`domain:modifyRequestBody:${ctx.url}`);
                  return `${body}|domain:${ctx.url}`;
                },
                modifyResponseBody(body) {
                  events.push("domain:modifyResponseBody");
                  return `${body}|domain`;
                },
                onResponse() {
                  events.push("domain:onResponse");
                },
              },
            },
          ],
          async (proxyPort) => {
            const response = await requestThroughProxy(proxyPort, {
              host: "api.example.com",
              path: "/pipeline?x=1",
              method: "POST",
              headers: { "content-type": "text/plain" },
              body: "payload",
            });

            expect(response.status).toBe(200);
            expect(response.body).toBe(
              "upstream:payload|global:http://api.example.com/pipeline?x=1|domain:http://api.example.com/pipeline?x=1|global|domain",
            );
          },
        );
      },
    );

    expect(events).toEqual([
      "global:onRequest:http://api.example.com/pipeline?x=1",
      "domain:onRequest:http://api.example.com/pipeline?x=1",
      "global:modifyRequestBody:http://api.example.com/pipeline?x=1",
      "domain:modifyRequestBody:http://api.example.com/pipeline?x=1",
      "global:modifyResponseBody",
      "domain:modifyResponseBody",
      "global:onResponse",
      "domain:onResponse",
    ]);
  });

  test("preserves domain-only HTTP behavior when no global rules match", async () => {
    const domainRule: ProxyRule = {
      target: "",
      modifyResponseBody(body) {
        return `${body}|domain-only`;
      },
    };

    await withUpstream(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("baseline");
      },
      async (upstreamPort) => {
        domainRule.target = `http://127.0.0.1:${upstreamPort}`;

        let baseline: Awaited<ReturnType<typeof requestThroughProxy>> | undefined;
        await withDiscoveredPlugins(
          [{ kind: "domain", domain: "api.example.com", rule: domainRule }],
          async (proxyPort) => {
            baseline = await requestThroughProxy(proxyPort, {
              host: "api.example.com",
              path: "/baseline",
            });
          },
        );

        let withMissedGlobal: Awaited<ReturnType<typeof requestThroughProxy>> | undefined;
        await withDiscoveredPlugins(
          [
            { kind: "global", name: "miss", rule: { match: "/never/", target: `http://127.0.0.1:${upstreamPort}` } },
            { kind: "domain", domain: "api.example.com", rule: domainRule },
          ],
          async (proxyPort) => {
            withMissedGlobal = await requestThroughProxy(proxyPort, {
              host: "api.example.com",
              path: "/baseline",
            });
          },
        );

        expect(withMissedGlobal).toEqual(baseline);
      },
    );
  });
});

