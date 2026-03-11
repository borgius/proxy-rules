import type { ProxyRule } from "./types.ts";
import type { DiscoveredPlugin } from "./discover-plugins.ts";
import { discoverPlugins } from "./discover-plugins.ts";
import { getLogger } from "../logging/logger.ts";

/**
 * Normalize a hostname by stripping configured ignored subdomains.
 *
 * e.g. with ignoreSubDomains: ["www"]
 *   www.example.com → example.com
 *   api.example.com → api.example.com (unchanged)
 *   www              → www (single label — unchanged)
 */
export function normalizeHostname(
  hostname: string,
  ignoreSubDomains: string[],
): string {
  const lower = hostname.toLowerCase().trim();
  const parts = lower.split(".");

  if (parts.length <= 1) return lower;

  const sub = parts[0]!;
  if (ignoreSubDomains.map((s) => s.toLowerCase()).includes(sub)) {
    return parts.slice(1).join(".");
  }
  return lower;
}

/**
 * Extract the hostname from a raw Host header value (strips port).
 */
export function extractHostname(hostHeader: string): string {
  // IPv6 literal [::1]:8080
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end !== -1 ? hostHeader.slice(0, end + 1) : hostHeader;
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon !== -1 ? hostHeader.slice(0, colon) : hostHeader;
}

interface RegistryEntry {
  domain: string;
  rule: ProxyRule;
  priority: number;
}

export class PluginRegistry {
  private entries: RegistryEntry[] = [];
  private ignoreSubDomains: string[];

  constructor(ignoreSubDomains: string[] = ["www"]) {
    this.ignoreSubDomains = ignoreSubDomains;
  }

  /** Replace entire registry atomically (used during hot reload). */
  replace(plugins: DiscoveredPlugin[]): void {
    this.entries = plugins.map((p) => ({
      domain: p.domain.toLowerCase(),
      rule: p.rule,
      priority: p.rule.priority ?? 0,
    }));
    // Sort descending by priority so the first match wins in find()
    this.entries.sort((a, b) => b.priority - a.priority);
  }

  /** Look up the best-matching rule for a given raw Host header or authority. */
  resolve(rawHost: string): ProxyRule | null {
    const hostname = extractHostname(rawHost);
    const normalized = normalizeHostname(hostname, this.ignoreSubDomains);

    // Exact match first, then try the original hostname if it differed
    const candidates = normalized !== hostname
      ? [normalized, hostname]
      : [normalized];

    for (const candidate of candidates) {
      const entry = this.entries.find((e) => e.domain === candidate);
      if (entry) return entry.rule;
    }

    return null;
  }

  get size(): number {
    return this.entries.length;
  }

  domains(): string[] {
    return this.entries.map((e) => e.domain);
  }
}

/** Build a PluginRegistry from the given rules directory. */
export async function buildRegistry(
  rulesDir: string,
  ignoreSubDomains: string[],
): Promise<PluginRegistry> {
  const plugins = await discoverPlugins(rulesDir);
  const registry = new PluginRegistry(ignoreSubDomains);
  registry.replace(plugins);
  getLogger().info(`Plugin registry ready: ${registry.size} domain(s) loaded`, {
    domains: registry.domains(),
  });
  return registry;
}
