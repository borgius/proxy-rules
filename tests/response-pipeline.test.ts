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

import { describe, expect, test } from "bun:test";
import http from "node:http";
import type net from "node:net";
import { initLogger } from "../src/logging/logger.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
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

  const proxy = createProxyServer();
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, proxy, registry, config);
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

/**
 * Send a plain HTTP request to our local proxy.
 * The proxy looks up the `host` header in the registry, applies the rule, and
 * forwards the request to the upstream HTTPS target transparently.
 */
async function requestThroughProxy(
  proxyPort: number,
  host: string,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path,
        method: "GET",
        headers: {
          host,
          // Ask for uncompressed response so we can compare the body as text.
          // The pipeline also injects this header but belt-and-suspenders here.
          "accept-encoding": "identity",
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
            "dummyjson.com",
            "/products",
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
            "dummyjson.com",
            "/products",
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

