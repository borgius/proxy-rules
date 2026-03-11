import { describe, expect, test, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type net from "node:net";
import type httpProxy from "http-proxy";
import { initLogger } from "../src/logging/logger.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
import { handleHttpRequest } from "../src/proxy/http-handler.ts";
import { handleWebSocketUpgrade } from "../src/proxy/websocket-handler.ts";
import type { ProxyConfig } from "../src/config/schema.ts";

const config: ProxyConfig = {
  port: 8080,
  host: "127.0.0.1",
  ignoreSubDomains: ["www"],
  logging: {
    level: "info",
    format: "json",
    maxBodyBytes: 0,
  },
  pluginHotReload: false,
  upstreamTimeout: 30_000,
};

function createRegistry(withRule = false): PluginRegistry {
  const registry = new PluginRegistry(config.ignoreSubDomains);

  if (withRule) {
    registry.replace([
      {
        domain: "monitored.internal",
        rule: {
          target: "http://monitored.internal",
        },
      },
    ]);
  }

  return registry;
}

async function captureStdout(run: () => void | Promise<void>): Promise<string> {
  const stdout = process.stdout;
  const originalWrite = stdout.write.bind(stdout);
  const chunks: string[] = [];

  stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof stdout.write;

  try {
    await run();
  } finally {
    stdout.write = originalWrite as typeof stdout.write;
  }

  return chunks.join("");
}

function createProxy(statusCode = 204): httpProxy {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();

  return {
    once(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
      return this;
    },
    web(req: http.IncomingMessage, res: http.ServerResponse) {
      void req;
      void res;
      const proxyRes = { statusCode } as http.IncomingMessage;
      const listener = listeners.get("proxyRes");
      if (listener) {
        void listener(proxyRes);
      }
    },
    ws() {
      return undefined;
    },
  } as unknown as httpProxy;
}

function createSocket(): net.Socket {
  const socket = new EventEmitter() as net.Socket;
  socket.destroy = () => socket;
  return socket;
}

beforeEach(() => {
  initLogger(config.logging);
});

describe("built-in traffic logging", () => {
  test("skips HTTP request logs when no rule matches", async () => {
    const output = await captureStdout(() => {
      handleHttpRequest(
        {
          headers: { host: "unknown.example.com" },
          method: "GET",
          url: "/status",
        } as http.IncomingMessage,
        {} as http.ServerResponse,
        createProxy(),
        createRegistry(false),
        config,
      );
    });

    expect(output).toBe("");
  });

  test("emits HTTP request logs when a rule matches", async () => {
    const output = await captureStdout(() => {
      handleHttpRequest(
        {
          headers: { host: "monitored.internal" },
          method: "GET",
          url: "/status",
        } as http.IncomingMessage,
        {} as http.ServerResponse,
        createProxy(200),
        createRegistry(true),
        config,
      );
    });

    expect(output).toContain('"msg":"→ HTTP"');
    expect(output).toContain('"msg":"← HTTP"');
    expect(output).toContain('"domain":"monitored.internal"');
  });

  test("skips WebSocket upgrade logs when no rule matches", async () => {
    const output = await captureStdout(() => {
      handleWebSocketUpgrade(
        {
          headers: { host: "unknown.example.com" },
          url: "/socket",
        } as http.IncomingMessage,
        createSocket(),
        Buffer.alloc(0),
        createProxy(),
        createRegistry(false),
        config,
      );
    });

    expect(output).toBe("");
  });

  test("emits WebSocket upgrade logs when a rule matches", async () => {
    const output = await captureStdout(() => {
      handleWebSocketUpgrade(
        {
          headers: { host: "monitored.internal" },
          url: "/socket",
        } as http.IncomingMessage,
        createSocket(),
        Buffer.alloc(0),
        createProxy(),
        createRegistry(true),
        config,
      );
    });

    expect(output).toContain('"msg":"⬌ WS upgrade"');
    expect(output).toContain('"domain":"monitored.internal"');
  });
});
