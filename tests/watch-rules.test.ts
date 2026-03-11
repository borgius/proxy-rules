import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
});