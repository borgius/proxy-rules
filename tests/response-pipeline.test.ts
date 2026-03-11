import { describe, expect, test, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type httpProxy from "http-proxy";
import { initLogger } from "../src/logging/logger.ts";
import { runResponsePipeline } from "../src/proxy/response-pipeline.ts";
import type { ProxyConfig } from "../src/config/schema.ts";
import type { ProxyRule } from "../src/plugins/types.ts";

// ---------------------------------------------------------------------------
// Realistic JSON fixtures modelled on the dummyjson.com API schema
// https://dummyjson.com/docs
// ---------------------------------------------------------------------------

const DUMMYJSON_PRODUCT = JSON.stringify({
  id: 1,
  title: "Essence Mascara Lash Princess",
  description: "Popular mascara known for its volumizing and lengthening effects.",
  category: "beauty",
  price: 9.99,
  discountPercentage: 10.48,
  rating: 4.94,
  stock: 5,
  tags: ["beauty", "mascara"],
  brand: "Essence",
  sku: "BEA-ESS-001",
  thumbnail: "https://cdn.dummyjson.com/product-images/beauty/thumbnail.webp",
});

const DUMMYJSON_USER = JSON.stringify({
  id: 1,
  firstName: "Emily",
  lastName: "Johnson",
  age: 29,
  email: "emily.johnson@x.dummyjson.com",
  username: "emilys",
  address: { city: "Phoenix", state: "Mississippi" },
});

const DUMMYJSON_PRODUCTS_LIST = JSON.stringify({
  products: [
    { id: 1, title: "Essence Mascara Lash Princess", price: 9.99, stock: 5 },
    { id: 2, title: "Eyeshadow Palette with Mirror", price: 20.00, stock: 44 },
    { id: 3, title: "Powder Canister", price: 14.99, stock: 59 },
  ],
  total: 3,
  skip: 0,
  limit: 3,
});

const config: ProxyConfig = {
  port: 8080,
  host: "127.0.0.1",
  ignoreSubDomains: ["www"],
  logging: {
    level: "error",
    format: "pretty",
    maxBodyBytes: 4096,
  },
  pluginHotReload: false,
  upstreamTimeout: 30_000,
};

class MockProxyResponse extends EventEmitter {
  statusCode = 200;
  headers: http.IncomingHttpHeaders;
  private readonly chunks: Buffer[];
  private emittedChunkCount = 0;

  constructor(headers: http.IncomingHttpHeaders, body: string | Buffer[]) {
    super();
    this.headers = headers;
    this.chunks = Array.isArray(body)
      ? body.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      : [Buffer.from(body, "utf8")];
  }

  start(): void {
    for (const chunk of this.chunks) {
      this.emittedChunkCount += 1;
      this.emit("data", chunk);
    }
    this.emit("end");
  }

  pipe(res: http.ServerResponse): http.ServerResponse {
    for (const chunk of this.chunks.slice(this.emittedChunkCount)) {
      res.write(chunk);
    }
    res.end();
    return res;
  }
}

function createProxy(proxyRes: MockProxyResponse): httpProxy {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();

  return {
    once(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
      return this;
    },
    web(req: http.IncomingMessage, res: http.ServerResponse) {
      void req;
      void res;
      const proxyResListener = listeners.get("proxyRes");
      if (proxyResListener) {
        void proxyResListener(proxyRes);
      }
      proxyRes.start();
    },
    ws() {
      return undefined;
    },
  } as unknown as httpProxy;
}

function createResponseRecorder() {
  const writes: Array<{ statusCode: number; headers: http.OutgoingHttpHeaders }> = [];
  let body = "";

  const res = {
    writeHead(statusCode: number, headers: http.OutgoingHttpHeaders) {
      writes.push({ statusCode, headers });
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
      return this;
    },
    write(chunk: string | Buffer) {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return true;
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    getBody: () => body,
    getLastWrite: () => writes.at(-1),
    getWrites: () => writes,
  };
}

beforeEach(() => {
  initLogger(config.logging);
});

function runPipeline(
  upstreamBody: string,
  upstreamHeaders: http.IncomingHttpHeaders,
  rule: ProxyRule,
  cfg = config,
) {
  const proxyRes = new MockProxyResponse(upstreamHeaders, upstreamBody);
  const proxy = createProxy(proxyRes);
  const recorder = createResponseRecorder();

  runResponsePipeline(
    { method: "GET", url: "/products/1" } as http.IncomingMessage,
    recorder.res,
    proxy,
    "https://dummyjson.com",
    rule,
    "dummyjson.com",
    cfg,
    { error() {}, info() {}, warn() {}, debug() {} } as never,
  );

  return recorder;
}

describe("runResponsePipeline", () => {
  // ---------------------------------------------------------------------------
  // Core correctness: dummyjson product response
  // ---------------------------------------------------------------------------

  test("modifies a dummyjson product response and produces valid JSON with correct content-length", async () => {
    const { res, getBody, getLastWrite } = runPipeline(
      DUMMYJSON_PRODUCT,
      {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(DUMMYJSON_PRODUCT, "utf8")),
        etag: '"abc123"',
        "x-powered-by": "dummyjson",
      },
      {
        modifyResponseBody(body) {
          const product = JSON.parse(body) as Record<string, unknown>;
          product["price"] = 0.01; // apply a discount
          product["tags"] = [...(product["tags"] as string[]), "sale"];
          return JSON.stringify(product);
        },
      },
    );

    await Bun.sleep(0);

    const resultBody = getBody();
    const product = JSON.parse(resultBody) as Record<string, unknown>;

    // Semantic check: modification applied
    expect(product["price"]).toBe(0.01);
    expect((product["tags"] as string[])).toContain("sale");
    expect((product["tags"] as string[])).toContain("mascara"); // original tag kept

    // Header correctness: content-length matches actual byte size of modified body
    const write = getLastWrite()!;
    expect(write.statusCode).toBe(200);
    const reportedLength = Number(write.headers["content-length"]);
    expect(reportedLength).toBe(Buffer.byteLength(resultBody, "utf8"));
    // etag must be stripped (stale after body change)
    expect(write.headers["etag"]).toBeUndefined();
    // non-content headers must be preserved
    expect(write.headers["x-powered-by"]).toBe("dummyjson");
  });

  test("modifies a dummyjson user response and outcome is parseable JSON", async () => {
    const { res, getBody, getLastWrite } = runPipeline(
      DUMMYJSON_USER,
      {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(DUMMYJSON_USER, "utf8")),
      },
      {
        modifyResponseBody(body) {
          const user = JSON.parse(body) as Record<string, unknown>;
          user["firstName"] = "Proxied";
          return JSON.stringify(user);
        },
      },
    );

    await Bun.sleep(0);

    const resultBody = getBody();
    const user = JSON.parse(resultBody) as Record<string, unknown>;
    expect(user["firstName"]).toBe("Proxied");
    expect(user["lastName"]).toBe("Johnson"); // unchanged field preserved

    const write = getLastWrite()!;
    expect(Number(write.headers["content-length"])).toBe(Buffer.byteLength(resultBody, "utf8"));
  });

  test("modifies a dummyjson products list and all items remain accessible", async () => {
    const { res, getBody, getLastWrite } = runPipeline(
      DUMMYJSON_PRODUCTS_LIST,
      {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(DUMMYJSON_PRODUCTS_LIST, "utf8")),
      },
      {
        modifyResponseBody(body) {
          const data = JSON.parse(body) as { products: Array<{ price: number }> };
          // Apply a 50% discount to all prices
          data.products = data.products.map((p) => ({ ...p, price: +(p.price * 0.5).toFixed(2) }));
          return JSON.stringify(data);
        },
      },
    );

    await Bun.sleep(0);

    const resultBody = getBody();
    const data = JSON.parse(resultBody) as { products: Array<{ price: number }> };

    expect(data.products).toHaveLength(3);
    expect(data.products[0]!.price).toBe(5.00);
    expect(data.products[1]!.price).toBe(10.00);

    const write = getLastWrite()!;
    expect(Number(write.headers["content-length"])).toBe(Buffer.byteLength(resultBody, "utf8"));
  });

  test("runs modifyResponseBody even when maxBodyBytes is 0 (body logging disabled)", async () => {
    const noLoggingConfig: ProxyConfig = {
      ...config,
      logging: { ...config.logging, maxBodyBytes: 0 },
    };
    const { res, getBody } = runPipeline(
      DUMMYJSON_PRODUCT,
      {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(DUMMYJSON_PRODUCT, "utf8")),
      },
      {
        modifyResponseBody(body) {
          const p = JSON.parse(body) as Record<string, unknown>;
          p["proxied"] = true;
          return JSON.stringify(p);
        },
      },
      noLoggingConfig,
    );

    await Bun.sleep(0);

    const resultBody = getBody();
    const product = JSON.parse(resultBody) as Record<string, unknown>;
    // Body MUST be modified even though body logging is turned off (maxBodyBytes: 0)
    expect(product["proxied"]).toBe(true);
    expect(product["id"]).toBe(1); // original fields kept
  });

  test("passes through gzip-encoded responses untouched", async () => {
    const { res, getBody, getWrites } = runPipeline(
      DUMMYJSON_PRODUCT,
      {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(Buffer.byteLength(DUMMYJSON_PRODUCT, "utf8")),
      },
      {
        modifyResponseBody() {
          return '{"hijacked":true}';
        },
      },
    );

    await Bun.sleep(0);

    // Must pass through the original bytes — body is compressed, do not mutate
    expect(getBody()).toBe(DUMMYJSON_PRODUCT);
    expect(getWrites()[0]?.headers["content-encoding"]).toBe("gzip");
    // content-length must NOT have been rewritten
    expect(Number(getWrites()[0]?.headers["content-length"])).toBe(
      Buffer.byteLength(DUMMYJSON_PRODUCT, "utf8"),
    );
  });

  test("falls back to passthrough cleanly when buffered body exceeds maxBodyBytes", async () => {
    const overflowConfig: ProxyConfig = {
      ...config,
      logging: {
        ...config.logging,
        maxBodyBytes: 5,
      },
    };
    const chunks = [Buffer.from("hello", "utf8"), Buffer.from(" world", "utf8")];
    const proxyRes = new MockProxyResponse(
      {
        "content-type": "text/html; charset=utf-8",
      },
      chunks,
    );
    const proxy = createProxy(proxyRes);
    const { res, getBody, getWrites } = createResponseRecorder();
    const rule: ProxyRule = {
      modifyResponseBody(body) {
        return body.toUpperCase();
      },
    };

    runResponsePipeline(
      { method: "GET", url: "/v1/test" } as http.IncomingMessage,
      res,
      proxy,
      "https://api.example.test",
      rule,
      "api.example.test",
      overflowConfig,
      { error() {}, info() {}, warn() {}, debug() {} } as never,
    );

    await Bun.sleep(0);

    expect(getBody()).toBe("hello world");
    expect(getWrites()).toEqual([
      {
        statusCode: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    ]);
  });
});