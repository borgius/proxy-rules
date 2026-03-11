import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load-config.ts";
import { parseConnectTarget, shouldInterceptConnect } from "../src/proxy/connect-handler.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "../src/plugins/plugin-registry.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/proxy-rules");

function createTempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

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

  test("merges global config with project-local rules and overrides", () => {
    const globalDir = createTempDir("proxy-rules-global");
    const workspaceDir = createTempDir("proxy-rules-workspace");
    const projectConfigDir = join(workspaceDir, ".proxy-rules");

    try {
      mkdirSync(join(workspaceDir, ".git"), { recursive: true });
      mkdirSync(join(projectConfigDir, "rules"), { recursive: true });

      writeFileSync(
        join(globalDir, "config.json"),
        JSON.stringify({
          host: "127.0.0.1",
          logging: {
            format: "json",
            maxBodyBytes: 1024,
          },
          upstreamTimeout: 45_000,
        }),
      );

      writeFileSync(
        join(projectConfigDir, "config.json"),
        JSON.stringify({
          port: 9090,
          logging: {
            level: "debug",
          },
          pluginHotReload: false,
        }),
      );

      const { config, paths } = loadConfig({
        cwd: workspaceDir,
        defaultConfigDir: globalDir,
      });

      expect(config.port).toBe(9090);
      expect(config.host).toBe("127.0.0.1");
      expect(config.logging.level).toBe("debug");
      expect(config.logging.format).toBe("json");
      expect(config.logging.maxBodyBytes).toBe(1024);
      expect(config.pluginHotReload).toBe(false);
      expect(config.upstreamTimeout).toBe(45_000);
      expect(paths.rulesDir).toBe(join(projectConfigDir, "rules"));
      expect(paths.caCertPath).toBe(join(globalDir, "certs", "ca-cert.pem"));
      expect(paths.configFiles).toEqual([
        join(globalDir, "config.json"),
        join(projectConfigDir, "config.json"),
      ]);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("uses rules override without changing cert location", () => {
    const globalDir = createTempDir("proxy-rules-global");
    const workspaceDir = createTempDir("proxy-rules-workspace");
    const projectConfigDir = join(workspaceDir, ".proxy-rules");
    const customRulesDir = join(workspaceDir, "custom-rules");

    try {
      mkdirSync(join(workspaceDir, ".git"), { recursive: true });
      mkdirSync(join(projectConfigDir, "rules"), { recursive: true });
      mkdirSync(customRulesDir, { recursive: true });

      const { paths } = loadConfig({
        cwd: workspaceDir,
        defaultConfigDir: globalDir,
        rulesDir: customRulesDir,
      });

      expect(paths.rulesDir).toBe(customRulesDir);
      expect(paths.caKeyPath).toBe(join(globalDir, "certs", "ca-key.pem"));
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("CONNECT handling helpers", () => {
  test("parses standard CONNECT authority", () => {
    expect(parseConnectTarget("example.com:8443")).toEqual({
      authority: "example.com:8443",
      hostname: "example.com",
      port: 8443,
    });
  });

  test("parses IPv6 CONNECT authority", () => {
    expect(parseConnectTarget("[::1]:443")).toEqual({
      authority: "[::1]:443",
      hostname: "[::1]",
      port: 443,
    });
  });

  test("intercepts only domains that have rules", () => {
    const registry = new PluginRegistry(["www"]);
    registry.replace([
      {
        domain: "example.com",
        rule: { target: "https://example.com" },
      },
    ]);

    expect(shouldInterceptConnect("example.com:443", registry)).toBe(true);
    expect(shouldInterceptConnect("www.example.com:443", registry)).toBe(true);
    expect(shouldInterceptConnect("google.com:443", registry)).toBe(false);
  });
});
