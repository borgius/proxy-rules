import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { discoverPlugins } from "../src/plugins/discover-plugins.ts";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";
import { initLogger } from "../src/logging/logger.ts";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const RULES_DIR = join(import.meta.dir, "fixtures/proxy-rules/rules");
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
  test("discovers all fixture domain folders", async () => {
    const plugins = await discoverPlugins(RULES_DIR);
    const domains = plugins.map((p) => p.domain).sort();
    // We have 4 fixture domains
    expect(domains).toContain("httpbin.org");
    expect(domains).toContain("api.example.com");
    expect(domains).toContain("json.example.com");
    expect(domains).toContain("monitored.internal");
  });

  test("returns empty array for non-existent directory", async () => {
    const plugins = await discoverPlugins("/tmp/__no_rules_dir__");
    expect(plugins).toEqual([]);
  });

  test("reloads updated rule module contents after file changes", async () => {
    const rulesDir = await createTempRulesDir();
    const domainDir = join(rulesDir, "api.example.test");
    await mkdir(domainDir, { recursive: true });
    await Bun.write(
      join(domainDir, "index.ts"),
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

    await Bun.write(
      join(domainDir, "index.ts"),
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
