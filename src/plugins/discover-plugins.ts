import { copyFileSync, existsSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ProxyRule } from "./types.ts";
import { getLogger } from "../logging/logger.ts";

export interface DiscoveredPlugin {
  domain: string;
  rule: ProxyRule;
}

/**
 * Dynamically import a single TypeScript/JavaScript module and extract its
 * default export as a ProxyRule.
 *
 * Cache busting strategy: copy the file to a uniquely-named temp path and
 * import that copy. Every import hits a path the runtime has never seen, so
 * no query-string tricks or runtime-specific cache APIs are needed. The temp
 * file is deleted in the `finally` block so no disk waste accumulates.
 */
async function importRule(filePath: string): Promise<ProxyRule | null> {
  const realFilePath = realpathSync(filePath);
  const ext = extname(realFilePath);
  const tmpPath = join(
    tmpdir(),
    `proxy-rule-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  copyFileSync(realFilePath, tmpPath);

  try {
    const mod = await import(pathToFileURL(tmpPath).href);
    const rule = mod.default as ProxyRule | undefined;
    if (!rule || typeof rule !== "object") {
      getLogger().warn(`Plugin file ${filePath} has no default export — skipping`);
      return null;
    }
    return rule;
  } catch (err) {
    getLogger().error(`Failed to import plugin ${filePath}`, {
      error: (err as Error).message,
    });
    return null;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Merge an ordered list of ProxyRule objects into a single combined rule.
 * Later rules override scalar fields; hooks are composed (all called in order).
 */
function mergeRules(rules: ProxyRule[]): ProxyRule {
  if (rules.length === 1) {
    return rules[0] as ProxyRule;
  }

  const merged: ProxyRule = {};

  // Last non-undefined target wins
  for (const r of rules) {
    if (r.target !== undefined) merged.target = r.target;
    if (r.priority !== undefined) merged.priority = r.priority;
    if (r.logging !== undefined) merged.logging = { ...merged.logging, ...r.logging };
  }

  // Compose async hooks — all fired in order
  const onRequests = rules.map((r) => r.onRequest).filter(Boolean) as NonNullable<ProxyRule["onRequest"]>[];
  if (onRequests.length) {
    merged.onRequest = async (ctx) => {
      for (const fn of onRequests) await fn(ctx);
    };
  }

  const onResponses = rules.map((r) => r.onResponse).filter(Boolean) as NonNullable<ProxyRule["onResponse"]>[];
  if (onResponses.length) {
    merged.onResponse = async (ctx) => {
      for (const fn of onResponses) await fn(ctx);
    };
  }

  const onConnects = rules.map((r) => r.onConnect).filter(Boolean) as NonNullable<ProxyRule["onConnect"]>[];
  if (onConnects.length) {
    merged.onConnect = async (ctx) => {
      for (const fn of onConnects) await fn(ctx);
    };
  }

  // Body modifier: last defined one wins (composing multiple body modifiers is fragile)
  for (const r of rules) {
    if (r.modifyResponseBody !== undefined) {
      merged.modifyResponseBody = r.modifyResponseBody;
    }
  }

  const onWsOpens = rules.map((r) => r.onWebSocketOpen).filter(Boolean) as NonNullable<ProxyRule["onWebSocketOpen"]>[];
  if (onWsOpens.length) {
    merged.onWebSocketOpen = (...args) => {
      for (const fn of onWsOpens) fn(...args);
    };
  }

  const onWsCloses = rules.map((r) => r.onWebSocketClose).filter(Boolean) as NonNullable<ProxyRule["onWebSocketClose"]>[];
  if (onWsCloses.length) {
    merged.onWebSocketClose = (...args) => {
      for (const fn of onWsCloses) fn(...args);
    };
  }

  return merged;
}

/**
 * Load all rules from a single domain directory.
 *
 * Supports:
 *   rules/example.com/index.ts          → single-file rule
 *   rules/example.com/a.ts + b.ts ...   → composed rules (alpha order, index.ts first)
 */
async function loadDomainFolder(domainDir: string): Promise<ProxyRule | null> {
  const entries = readdirSync(domainDir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .sort((a, b) => {
      // index.ts always first, then alphabetical
      if (a === "index.ts" || a === "index.js") return -1;
      if (b === "index.ts" || b === "index.js") return 1;
      return a.localeCompare(b);
    });

  if (entries.length === 0) return null;

  const rules: ProxyRule[] = [];
  for (const entry of entries) {
    const rule = await importRule(join(domainDir, entry));
    if (rule) rules.push(rule);
  }

  if (rules.length === 0) return null;
  return mergeRules(rules);
}

/**
 * Scan the `rulesDir` and return all successfully loaded domain plugins.
 */
export async function discoverPlugins(rulesDir: string): Promise<DiscoveredPlugin[]> {
  if (!existsSync(rulesDir)) {
    getLogger().debug("Rules directory does not exist, skipping plugin discovery", { rulesDir });
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];

  const entries = readdirSync(rulesDir);
  for (const entry of entries) {
    const fullPath = join(rulesDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const domain = entry;
      const rule = await loadDomainFolder(fullPath);
      if (rule) {
        plugins.push({ domain, rule });
        getLogger().debug(`Loaded plugin for domain: ${domain}`);
      }
    } else if ((entry.endsWith(".ts") || entry.endsWith(".js")) && !entry.startsWith("_")) {
      // Top-level single files: basename without extension becomes the domain
      const domain = basename(entry, entry.endsWith(".ts") ? ".ts" : ".js");
      const rule = await importRule(fullPath);
      if (rule) {
        plugins.push({ domain, rule });
        getLogger().debug(`Loaded top-level plugin for domain: ${domain}`);
      }
    }
  }

  return plugins;
}
