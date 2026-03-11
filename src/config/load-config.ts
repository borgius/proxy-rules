import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  ProxyConfigFileSchema,
  ProxyConfigSchema,
  type PartialProxyConfig,
  type ProxyConfig,
} from "./schema.ts";

const DEFAULT_CONFIG_DIR = join(homedir(), ".proxy-rules");
const PROJECT_CONFIG_DIR_NAME = ".proxy-rules";

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
  configFiles: string[];
  rulesDir: string;
  certsDir: string;
  certsDomainDir: string;
  caCertPath: string;
  caKeyPath: string;
  logsDir: string;
}

export interface ResolvePathsOptions {
  configDir: string;
  rulesDir?: string;
  certsDirBase?: string;
  configFiles?: string[];
}

export function resolvePaths(options: ResolvePathsOptions): ResolvedPaths {
  const configDir = resolve(expandHome(options.configDir));
  const rulesDir = options.rulesDir
    ? resolve(expandHome(options.rulesDir))
    : join(configDir, "rules");
  const certsDirBase = options.certsDirBase
    ? resolve(expandHome(options.certsDirBase))
    : configDir;

  return {
    configDir,
    configFile: join(configDir, "config.json"),
    configFiles: options.configFiles ?? [join(configDir, "config.json")],
    rulesDir,
    certsDir: join(certsDirBase, "certs"),
    certsDomainDir: join(certsDirBase, "certs", "domains"),
    caCertPath: join(certsDirBase, "certs", "ca-cert.pem"),
    caKeyPath: join(certsDirBase, "certs", "ca-key.pem"),
    logsDir: join(configDir, "logs"),
  };
}

export interface CliOverrides {
  port?: number;
  host?: string;
}

export interface LoadConfigOptions {
  configDir?: string;
  rulesDir?: string;
  overrides?: CliOverrides;
  cwd?: string;
  defaultConfigDir?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigObjects<T extends Record<string, unknown>>(base: T, override: T): T {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeConfigObjects(existing, value);
      continue;
    }

    merged[key] = value;
  }

  return merged as T;
}

function loadConfigFragment(configFile: string): PartialProxyConfig {
  if (!existsSync(configFile)) {
    return {};
  }

  const text = readFileSync(configFile, "utf-8");
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse config file at ${configFile}: ${(err as Error).message}`,
    );
  }

  const parsed = ProxyConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${configFile}:\n${parsed.error.toString()}`,
    );
  }

  return parsed.data;
}

export function findGitRoot(startDir: string = process.cwd()): string | undefined {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function normalizeLoadOptions(
  configDirOrOptions: string | LoadConfigOptions | undefined,
  overrides: CliOverrides,
): Required<Pick<LoadConfigOptions, "cwd" | "defaultConfigDir">> &
  Pick<LoadConfigOptions, "configDir" | "rulesDir"> & { overrides: CliOverrides } {
  if (typeof configDirOrOptions === "string") {
    return {
      configDir: configDirOrOptions,
      rulesDir: undefined,
      overrides,
      cwd: process.cwd(),
      defaultConfigDir: DEFAULT_CONFIG_DIR,
    };
  }

  const options = configDirOrOptions ?? {};
  return {
    configDir: options.configDir,
    rulesDir: options.rulesDir,
    overrides: options.overrides ?? overrides,
    cwd: options.cwd ?? process.cwd(),
    defaultConfigDir: options.defaultConfigDir ?? DEFAULT_CONFIG_DIR,
  };
}

/**
 * Load the global proxy config.
 *
 * If `configDir` is provided, only that config root is used.
 * Otherwise the loader merges `~/.proxy-rules/config.json` with
 * `<git-root>/.proxy-rules/config.json` when present, with project values
 * taking precedence over global ones.
 */
export function loadConfig(
  configDirRaw: string | LoadConfigOptions = {},
  overrides: CliOverrides = {},
): { config: ProxyConfig; paths: ResolvedPaths } {
  const options = normalizeLoadOptions(configDirRaw, overrides);
  const explicitConfigDir = options.configDir
    ? resolve(expandHome(options.configDir))
    : undefined;
  const defaultConfigDir = resolve(expandHome(options.defaultConfigDir));
  const projectRoot = explicitConfigDir ? undefined : findGitRoot(options.cwd);
  const projectConfigDir = projectRoot
    ? join(projectRoot, PROJECT_CONFIG_DIR_NAME)
    : undefined;

  const configDirs = explicitConfigDir
    ? [explicitConfigDir]
    : [defaultConfigDir, ...(projectConfigDir && existsSync(projectConfigDir) ? [projectConfigDir] : [])];
  const configFiles = [...new Set(configDirs.map((dir) => join(dir, "config.json")))];

  let mergedRaw: PartialProxyConfig = {};
  for (const configFile of configFiles) {
    mergedRaw = mergeConfigObjects(mergedRaw, loadConfigFragment(configFile));
  }

  const parsed = ProxyConfigSchema.safeParse(mergedRaw);
  if (!parsed.success) {
    throw new Error(
      `Invalid merged config:\n${parsed.error.toString()}`,
    );
  }

  const primaryConfigDir = explicitConfigDir ?? projectConfigDir ?? defaultConfigDir;
  const certsDirBase = explicitConfigDir ?? defaultConfigDir;
  const paths = resolvePaths({
    configDir: primaryConfigDir,
    rulesDir: options.rulesDir ?? (explicitConfigDir ? undefined : projectConfigDir && existsSync(projectConfigDir) ? join(projectConfigDir, "rules") : undefined),
    certsDirBase,
    configFiles,
  });

  const config: ProxyConfig = {
    ...parsed.data,
    ...(options.overrides.port !== undefined ? { port: options.overrides.port } : {}),
    ...(options.overrides.host !== undefined ? { host: options.overrides.host } : {}),
  };

  return { config, paths };
}
