import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { discoverPlugins } from "../src/plugins/discover-plugins.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
import { initLogger } from "../src/logging/logger.ts";
import type { ProxyRule } from "../src/plugins/types.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import { PassThrough } from "node:stream";
import type { ContextHelpers } from "../src/plugins/types.ts";

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/proxy-rules/rules");
const tempDirs: string[] = [];

async function createTempRulesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proxy-rules-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  initLogger({ level: "error", format: "pretty", maxBodyBytes: 0 });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("discoverPlugins", () => {
  test("allows matcher variants on the public rule contract", () => {
    const rules: ProxyRule[] = [
      { match: "/api/", target: "https://string.example.test" },
      { match: /\/admin\//, target: "https://regexp.example.test" },
      { match: (url) => url.includes("/sync/"), target: "https://sync.example.test" },
      { match: async (url) => url.includes("/async/"), target: "https://async.example.test" },
    ];

    expect(rules).toHaveLength(4);
  });

  test("discovers all fixture domain folders", async () => {
    const plugins = await discoverPlugins(RULES_DIR);
    const domains = plugins
      .filter((p) => p.kind !== "global")
      .map((p) => p.domain)
      .sort();
    // We have 4 fixture domains
    expect(domains).toContain("httpbin.org");
    expect(domains).toContain("api.example.com");
    expect(domains).toContain("json.example.com");
    expect(domains).toContain("monitored.internal");
  });

  test("discovers rules/global separately from domain rules", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    const globalDir = join(rulesDir, "global");
    const globalFolderRuleDir = join(globalDir, "audit");

    await mkdir(domainDir, { recursive: true });
    await mkdir(globalFolderRuleDir, { recursive: true });

    await writeFile(
      join(domainDir, "index.js"),
      [
        "export default {",
        "  target: 'https://api.example.test',",
        "};",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(globalDir, "path-prefix.js"),
      [
        "export default {",
        "  match: '/api/',",
        "  target: 'https://global-string.example.test',",
        "};",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(globalFolderRuleDir, "index.js"),
      [
        "export default {",
        "  match: /\\/audit\\//,",
        "  target: 'https://global-regexp.example.test',",
        "};",
        "",
      ].join("\n"),
    );

    const plugins = await discoverPlugins(rulesDir);
    const domains = plugins
      .filter((plugin) => plugin.kind !== "global")
      .map((plugin) => plugin.domain)
      .sort();
    const globals = plugins
      .filter((plugin) => plugin.kind === "global")
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(domains).toEqual(["api.example.test"]);
    expect(globals).toHaveLength(2);
    expect(globals.map((plugin) => plugin.name)).toEqual(["audit", "path-prefix"]);
    expect(globals[0]?.rule.match).toBeInstanceOf(RegExp);
    expect(globals[1]?.rule.match).toBe("/api/");
    expect(plugins.some((plugin) => plugin.kind !== "global" && plugin.domain === "global")).toBe(false);
  });

  test("returns empty array for non-existent directory", async () => {
    const plugins = await discoverPlugins("/tmp/__no_rules_dir__");
    expect(plugins).toEqual([]);
  });

  test("reloads updated rule module contents after file changes", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(
      join(domainDir, "index.js"),
      [
        "const rule = {",
        "  target: 'https://first.example.test',",
        "  modifyResponseBody(body) {",
        "    return body.replace('before', 'first');",
        "  },",
        "};",
        "",
        "export default rule;",
        "",
      ].join("\n"),
    );

    const firstLoad = await discoverPlugins(rulesDir);
    expect(firstLoad).toHaveLength(1);
    expect(firstLoad[0]?.rule.target).toBe("https://first.example.test");
    expect(firstLoad[0]?.rule.modifyResponseBody?.("before", {} as never)).toBe("first");

    await writeFile(
      join(domainDir, "index.js"),
      [
        "const rule = {",
        "  target: 'https://second.example.test',",
        "  modifyResponseBody(body) {",
        "    return body.replace('before', 'second');",
        "  },",
        "};",
        "",
        "export default rule;",
        "",
      ].join("\n"),
    );

    const secondLoad = await discoverPlugins(rulesDir);
    expect(secondLoad).toHaveLength(1);
    expect(secondLoad[0]?.rule.target).toBe("https://second.example.test");
    expect(secondLoad[0]?.rule.modifyResponseBody?.("before", {} as never)).toBe("second");
  });
});

describe("PluginRegistry.resolve", () => {
  let registry: PluginRegistry;

  beforeAll(async () => {
    const plugins = await discoverPlugins(RULES_DIR);
    registry = new PluginRegistry(["www"]);
    registry.replace(plugins);
  });

  test("resolves exact domain", () => {
    const rule = registry.resolve("httpbin.org");
    expect(rule).not.toBeNull();
  });

  test("resolves domain with port in host header", () => {
    const rule = registry.resolve("api.example.com:443");
    expect(rule).not.toBeNull();
  });

  test("normalises www. prefix", () => {
    // www.httpbin.org → httpbin.org
    const rule = registry.resolve("www.httpbin.org");
    expect(rule).not.toBeNull();
  });

  test("returns null for unknown domain", () => {
    const rule = registry.resolve("unknown.example.com");
    expect(rule).toBeNull();
  });

  test("does not treat rules/global as a fake hostname", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    const globalDir = join(rulesDir, "global");

    await mkdir(domainDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });

    await writeFile(join(domainDir, "index.js"), "export default { target: 'https://api.example.test' };\n");
    await writeFile(join(globalDir, "all.js"), "export default { match: '/all/', target: 'https://global.example.test' };\n");

    const registryWithGlobalNamespace = new PluginRegistry(["www"]);
    registryWithGlobalNamespace.replace(await discoverPlugins(rulesDir));

    expect(registryWithGlobalNamespace.resolve("api.example.test")).not.toBeNull();
    expect(registryWithGlobalNamespace.resolve("global")).toBeNull();
  });

  test("resolves logging-only rule with no target", () => {
    const rule = registry.resolve("monitored.internal");
    expect(rule).not.toBeNull();
    if (!rule) {
      throw new Error("Expected monitored.internal rule to resolve");
    }
    expect(rule.target).toBeUndefined();
    expect(typeof rule.onConnect).toBe("function");
  });
});

describe("PluginRegistry.resolveHttpRule", () => {
  function createRequest(options: {
    url?: string;
    host?: string;
    encrypted?: boolean;
  } = {}): http.IncomingMessage {
    const req = new http.IncomingMessage(new PassThrough() as never);
    req.url = options.url ?? "/";
    req.headers.host = options.host ?? "api.example.com";
    Object.assign(req.socket, { encrypted: options.encrypted ?? false });
    return req;
  }

  function createHelpers(): ContextHelpers {
    return {
      toCurl: () => "curl",
      toFetch: () => ({ url: "http://example.test", options: { method: "GET", headers: {} } }),
      toJson: () => ({}),
      saveTo: async () => undefined,
    };
  }

  test("evaluates string, RegExp, sync function, async function, and missing-match globals against an absolute proxy URL", async () => {
    const registry = new PluginRegistry(["www"]);
    const events: string[] = [];

    registry.replace([
      {
        kind: "global",
        name: "always",
        rule: {
          onRequest: async () => {
            events.push("always");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "string",
        rule: {
          match: "/v1/",
          onRequest: async () => {
            events.push("string");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "regexp",
        rule: {
          match: /users\?active=true/,
          onRequest: async () => {
            events.push("regexp");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "sync",
        rule: {
          match: (url) => url.startsWith("http://api.example.com/v1/"),
          onRequest: async () => {
            events.push("sync");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "async",
        rule: {
          match: async (url) => url.endsWith("active=true"),
          onRequest: async () => {
            events.push("async");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "miss",
        rule: {
          match: "/admin/",
          onRequest: async () => {
            events.push("miss");
            return undefined;
          },
        },
      },
      {
        kind: "domain",
        domain: "api.example.com",
        rule: {
          onRequest: async () => {
            events.push("domain");
            return undefined;
          },
        },
      },
    ]);

    const resolved = await registry.resolveHttpRule(
      "api.example.com",
      createRequest({ url: "http://api.example.com/v1/users?active=true" }),
    );

    expect(resolved.domain).toBe("api.example.com");
    expect(resolved.url).toBe("http://api.example.com/v1/users?active=true");
    expect(resolved.matchedGlobalIds).toEqual(["always", "string", "regexp", "sync", "async"]);

    if (!resolved.rule) {
      throw new Error("Expected a composed rule");
    }

    await resolved.rule.onRequest?.({
      req: createRequest({ url: resolved.url }),
      proxyReq: { setHeader() {}, destroy() {} } as unknown as http.ClientRequest,
      res: new http.ServerResponse(createRequest()),
      domain: resolved.domain,
      url: resolved.url,
    });

    expect(events).toEqual(["always", "string", "regexp", "sync", "async", "domain"]);
  });

  test("reconstructs an absolute HTTPS URL for decrypted relative-path requests", async () => {
    const registry = new PluginRegistry(["www"]);

    registry.replace([
      {
        kind: "global",
        name: "secure-path",
        rule: { match: /^https:\/\/api\.example\.com\/secure/ },
      },
      {
        kind: "domain",
        domain: "api.example.com",
        rule: { target: "https://upstream.example.test" },
      },
    ]);

    const resolved = await registry.resolveHttpRule(
      "api.example.com:443",
      createRequest({ url: "/secure/orders?id=42", host: "api.example.com:443", encrypted: true }),
    );

    expect(resolved.url).toBe("https://api.example.com/secure/orders?id=42");
    expect(resolved.matchedGlobalIds).toEqual(["secure-path"]);
  });

  test("preserves current domain-only behavior when no globals match", async () => {
    const registry = new PluginRegistry(["www"]);
    const domainRule: ProxyRule = { target: "https://domain-only.example.test" };

    registry.replace([
      { kind: "global", name: "miss", rule: { match: "/never/", target: "https://global.example.test" } },
      { kind: "domain", domain: "api.example.com", rule: domainRule },
    ]);

    const resolved = await registry.resolveHttpRule(
      "api.example.com",
      createRequest({ url: "http://api.example.com/v1/orders" }),
    );

    expect(resolved.matchedGlobalIds).toEqual([]);
    expect(resolved.rule).toBe(domainRule);
  });

  test("stops onRequest composition at the first StaticResponse", async () => {
    const registry = new PluginRegistry(["www"]);
    const events: string[] = [];

    registry.replace([
      {
        kind: "global",
        name: "first",
        rule: {
          onRequest: async () => {
            events.push("first");
            return undefined;
          },
        },
      },
      {
        kind: "global",
        name: "second",
        rule: {
          onRequest: async () => {
            events.push("second");
            return { status: 418, body: "short-circuit" };
          },
        },
      },
      {
        kind: "domain",
        domain: "api.example.com",
        rule: {
          onRequest: async () => {
            events.push("domain");
            return undefined;
          },
        },
      },
    ]);

    const resolved = await registry.resolveHttpRule(
      "api.example.com",
      createRequest({ url: "http://api.example.com/v1/orders" }),
    );

    if (!resolved.rule) {
      throw new Error("Expected a composed rule");
    }

    const response = await resolved.rule.onRequest?.({
      req: createRequest({ url: resolved.url }),
      proxyReq: { setHeader() {}, destroy() {} } as unknown as http.ClientRequest,
      res: new http.ServerResponse(createRequest()),
      domain: resolved.domain,
      url: resolved.url,
    });

    expect(response).toEqual({ status: 418, body: "short-circuit" });
    expect(events).toEqual(["first", "second"]);
  });

  test("chains request and response body modifiers sequentially with globals first and domain last", async () => {
    const registry = new PluginRegistry(["www"]);
    const resolveTarget = vi.fn(async () => "https://domain.example.test");

    registry.replace([
      {
        kind: "global",
        name: "a",
        rule: {
          target: "https://global-a.example.test",
          modifyRequestBody: async (body) => `${body}|ga`,
          modifyResponseBody: async (body) => `${body}|ga`,
          resolveTarget: async () => "https://global-a.example.test",
        },
      },
      {
        kind: "global",
        name: "b",
        rule: {
          target: "https://global-b.example.test",
          modifyRequestBody: async (body) => `${body}|gb`,
          modifyResponseBody: async (body) => `${body}|gb`,
          resolveTarget: async () => "https://global-b.example.test",
        },
      },
      {
        kind: "domain",
        domain: "api.example.com",
        rule: {
          target: "https://domain.example.test",
          modifyRequestBody: async (body) => `${body}|domain`,
          modifyResponseBody: async (body) => `${body}|domain`,
          resolveTarget,
        },
      },
    ]);

    const resolved = await registry.resolveHttpRule(
      "api.example.com",
      createRequest({ url: "http://api.example.com/v1/orders" }),
    );

    if (!resolved.rule) {
      throw new Error("Expected a composed rule");
    }

    const modifiedRequestBody = await resolved.rule.modifyRequestBody?.("body", {
      req: createRequest({ url: resolved.url }),
      proxyReq: { setHeader() {}, destroy() {} } as unknown as http.ClientRequest,
      res: new http.ServerResponse(createRequest()),
      domain: resolved.domain,
      url: resolved.url,
      contentType: "application/json",
    });
    const modifiedResponseBody = await resolved.rule.modifyResponseBody?.("body", {
      req: createRequest({ url: resolved.url }),
      proxyRes: createRequest({ url: resolved.url }),
      res: new http.ServerResponse(createRequest()),
      domain: resolved.domain,
      helpers: createHelpers(),
      contentType: "application/json",
    });
    const target = await resolved.rule.resolveTarget?.(createRequest({ url: resolved.url }), resolved.domain);

    expect(modifiedRequestBody).toBe("body|ga|gb|domain");
    expect(modifiedResponseBody).toBe("body|ga|gb|domain");
    expect(target).toBe("https://domain.example.test");
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });
});

describe("PluginRegistry.replace (hot reload)", () => {
  test("swap replaces domains atomically", async () => {
    const registry = new PluginRegistry(["www"]);

    const pluginsA = [{ domain: "alpha.test", rule: { target: "http://alpha" } }];
    const pluginsB = [{ domain: "beta.test", rule: { target: "http://beta" } }];

    registry.replace(pluginsA);
    expect(registry.resolve("alpha.test")).not.toBeNull();
    expect(registry.resolve("beta.test")).toBeNull();

    registry.replace(pluginsB);
    expect(registry.resolve("alpha.test")).toBeNull();
    expect(registry.resolve("beta.test")).not.toBeNull();
  });
});
