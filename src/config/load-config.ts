import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ProxyConfigSchema, type ProxyConfig } from "./schema.ts";

const DEFAULT_CONFIG_DIR = join(homedir(), ".proxy-rules");

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export interface ResolvedPaths {
  configDir: string;
  configFile: string;
  rulesDir: string;
  certsDir: string;
  certsDomainDir: string;
  caCertPath: string;
  caKeyPath: string;
  logsDir: string;
}

export function resolvePaths(configDir: string): ResolvedPaths {
  const d = resolve(expandHome(configDir));
  return {
    configDir: d,
    configFile: join(d, "config.json"),
    rulesDir: join(d, "rules"),
    certsDir: join(d, "certs"),
    certsDomainDir: join(d, "certs", "domains"),
    caCertPath: join(d, "certs", "ca-cert.pem"),
    caKeyPath: join(d, "certs", "ca-key.pem"),
    logsDir: join(d, "logs"),
  };
}

export interface CliOverrides {
  port?: number;
  host?: string;
}

/**
 * Load the global proxy config.
 *
 * 1. Reads `<configDir>/config.json` if it exists.
 * 2. Parses + validates via Zod (applies defaults for missing fields).
 * 3. Merges CLI flag overrides on top.
 * 4. Returns validated config and resolved filesystem paths.
 */
export function loadConfig(
  configDirRaw: string = DEFAULT_CONFIG_DIR,
  overrides: CliOverrides = {},
): { config: ProxyConfig; paths: ResolvedPaths } {
  const paths = resolvePaths(configDirRaw);

  // Ensure the config directory exists
  if (!existsSync(paths.configDir)) {
    mkdirSync(paths.configDir, { recursive: true });
  }

  let raw: unknown = {};
  if (existsSync(paths.configFile)) {
    const text = readFileSync(paths.configFile, "utf-8");
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Failed to parse config file at ${paths.configFile}: ${(err as Error).message}`,
      );
    }
  }

  const parsed = ProxyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${paths.configFile}:\n${parsed.error.toString()}`,
    );
  }

  const config: ProxyConfig = {
    ...parsed.data,
    ...(overrides.port !== undefined ? { port: overrides.port } : {}),
    ...(overrides.host !== undefined ? { host: overrides.host } : {}),
  };

  return { config, paths };
}
