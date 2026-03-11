import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/load-config.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/proxy-rules");

describe("loadConfig", () => {
  test("loads and parses fixture config.json", () => {
    const { config, paths } = loadConfig(FIXTURES_DIR);
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.ignoreSubDomains).toEqual(["www", "m"]);
    expect(config.logging.level).toBe("info");
    expect(paths.rulesDir).toBe(join(FIXTURES_DIR, "rules"));
  });

  test("applies default values for missing fields", () => {
    // Temp dir that has no config.json — should fall back to defaults
    const { config } = loadConfig("/tmp/__proxy_rules_no_config__");
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.ignoreSubDomains).toEqual(["www"]);
  });

  test("CLI overrides take precedence over file config", () => {
    const { config } = loadConfig(FIXTURES_DIR, { port: 9999, host: "127.0.0.1" });
    expect(config.port).toBe(9999);
    expect(config.host).toBe("127.0.0.1");
  });

  test("throws on malformed config.json", () => {
    // Write a bad file temporarily
    const fs = require("fs") as typeof import("fs");
    const tmpDir = "/tmp/__proxy_rules_bad_config__";
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(join(tmpDir, "config.json"), "{ invalid json }");
    expect(() => loadConfig(tmpDir)).toThrow();
    fs.rmSync(tmpDir, { recursive: true });
  });
});
