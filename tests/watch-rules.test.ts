import { afterEach, beforeEach, describe, expect, test } from "vitest";
import http from "node:http";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { initLogger } from "../src/logging/logger.ts";
import { discoverPlugins } from "../src/plugins/discover-plugins.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
import { watchRules } from "../src/watch/watch-config-and-rules.ts";

const tempDirs: string[] = [];
const watcherClosers: Array<() => Promise<unknown>> = [];

async function createTempRulesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proxy-rules-watch-"));
  tempDirs.push(dir);
  return dir;
}

async function writeRule(filePath: string, target: string, replacement: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "const rule = {",
      `  target: '${target}',`,
      "  modifyResponseBody(body) {",
      `    return body.replace('before', '${replacement}');`,
      "  },",
      "};",
      "",
      "export default rule;",
      "",
    ].join("\n"),
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function createRequest(options: {
  url?: string;
  host?: string;
  encrypted?: boolean;
} = {}): http.IncomingMessage {
  const req = new http.IncomingMessage(new PassThrough() as never);
  req.url = options.url ?? "/";
  req.headers.host = options.host ?? "api.example.test";
  Object.assign(req.socket, { encrypted: options.encrypted ?? false });
  return req;
}

beforeEach(() => {
  initLogger({ level: "error", format: "pretty", maxBodyBytes: 4096 });
});

afterEach(async () => {
  await Promise.all(watcherClosers.splice(0).map((close) => close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("watchRules", () => {
  test("reloads a modified rule file without restarting", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    const ruleFile = join(domainDir, "index.js");

    await mkdir(domainDir, { recursive: true });
    await writeRule(ruleFile, "https://first.example.test", "first");

    const registry = new PluginRegistry(["www"]);
    registry.replace(await discoverPlugins(rulesDir));

    const initialRule = registry.resolve("api.example.test");
    expect(initialRule?.target).toBe("https://first.example.test");
    expect(initialRule?.modifyResponseBody?.("before", {} as never)).toBe("first");

    const watcher = watchRules(rulesDir, registry);
    watcherClosers.push(() => watcher.close());

    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

    await writeRule(ruleFile, "https://second.example.test", "second");

    await waitFor(() => registry.resolve("api.example.test")?.target === "https://second.example.test");

    const reloadedRule = registry.resolve("api.example.test");
    expect(reloadedRule?.target).toBe("https://second.example.test");
    expect(reloadedRule?.modifyResponseBody?.("before", {} as never)).toBe("second");
  });

  test("reloads global rules when files under rules/global are added, changed, and removed", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    const globalDir = join(rulesDir, "global");
    const globalRuleFile = join(globalDir, "audit.js");

    await mkdir(domainDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });

    await writeFile(
      join(domainDir, "index.js"),
      [
        "export default {",
        "  target: 'https://domain.example.test',",
        "};",
        "",
      ].join("\n"),
    );

    const registry = new PluginRegistry(["www"]);
    registry.replace(await discoverPlugins(rulesDir));

    const watcher = watchRules(rulesDir, registry);
    watcherClosers.push(() => watcher.close());

    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

    const resolveOrders = () =>
      registry.resolveHttpRule(
        "api.example.test",
        createRequest({ url: "http://api.example.test/orders?id=1", host: "api.example.test" }),
      );
    const resolveProducts = () =>
      registry.resolveHttpRule(
        "api.example.test",
        createRequest({ url: "http://api.example.test/products?id=1", host: "api.example.test" }),
      );

    expect((await resolveOrders()).matchedGlobalIds).toEqual([]);
    expect((await resolveProducts()).matchedGlobalIds).toEqual([]);

    await writeFile(
      globalRuleFile,
      [
        "export default {",
        "  match: '/orders',",
        "};",
        "",
      ].join("\n"),
    );

    await waitFor(async () => {
      const resolved = await resolveOrders();
      return JSON.stringify(resolved.matchedGlobalIds) === JSON.stringify(["audit"]);
    });

    expect((await resolveOrders()).matchedGlobalIds).toEqual(["audit"]);
    expect((await resolveProducts()).matchedGlobalIds).toEqual([]);

    await writeFile(
      globalRuleFile,
      [
        "export default {",
        "  match: '/products',",
        "};",
        "",
      ].join("\n"),
    );

    await waitFor(async () => {
      const [orders, products] = await Promise.all([resolveOrders(), resolveProducts()]);
      return orders.matchedGlobalIds.length === 0 && JSON.stringify(products.matchedGlobalIds) === JSON.stringify(["audit"]);
    });

    expect((await resolveOrders()).matchedGlobalIds).toEqual([]);
    expect((await resolveProducts()).matchedGlobalIds).toEqual(["audit"]);

    await rm(globalRuleFile, { force: true });

    await waitFor(async () => {
      const [orders, products] = await Promise.all([resolveOrders(), resolveProducts()]);
      return orders.matchedGlobalIds.length === 0 && products.matchedGlobalIds.length === 0;
    });

    expect((await resolveOrders()).matchedGlobalIds).toEqual([]);
    expect((await resolveProducts()).matchedGlobalIds).toEqual([]);
  });
});