import type http from "node:http";
import type { ProxyRule } from "./types.ts";
import type { DiscoveredPlugin } from "./discover-plugins.ts";
import { discoverPlugins } from "./discover-plugins.ts";
import { getLogger } from "../logging/logger.ts";
import { buildRequestUrl } from "./context-helpers.ts";

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

  const sub = parts[0];
  if (sub && ignoreSubDomains.map((s) => s.toLowerCase()).includes(sub)) {
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
  order: number;
}

interface GlobalRegistryEntry {
  id: string;
  rule: ProxyRule;
  priority: number;
  order: number;
}

export interface ResolvedHttpRule {
  domain: string;
  url: string;
  rule: ProxyRule | null;
  matchedGlobalIds: string[];
}

function compareEntriesByPriorityThenOrder(
  a: { priority: number; order: number },
  b: { priority: number; order: number },
): number {
  return b.priority - a.priority || a.order - b.order;
}

async function matchesGlobalRule(
  rule: ProxyRule,
  url: string,
  req: http.IncomingMessage,
): Promise<boolean> {
  if (rule.match === undefined) return true;

  if (typeof rule.match === "string") {
    return url.includes(rule.match);
  }

  if (rule.match instanceof RegExp) {
    rule.match.lastIndex = 0;
    return rule.match.test(url);
  }

  return await rule.match(url, req);
}

function composeHttpRules(rules: ProxyRule[]): ProxyRule {
  const composed: ProxyRule = {};

  for (const rule of rules) {
    if (rule.target !== undefined) composed.target = rule.target;
    if (rule.priority !== undefined) composed.priority = rule.priority;
    if (rule.logging !== undefined) composed.logging = { ...composed.logging, ...rule.logging };
  }

  const resolveTargets = rules
    .map((rule) => rule.resolveTarget)
    .filter((resolveTarget): resolveTarget is NonNullable<ProxyRule["resolveTarget"]> => Boolean(resolveTarget));
  if (resolveTargets.length > 0) {
    composed.resolveTarget = async (req, domain) => {
      let nextTarget: string | undefined;
      for (const resolveTarget of resolveTargets) {
        const resolved = await resolveTarget(req, domain);
        if (resolved !== undefined) nextTarget = resolved;
      }
      return nextTarget;
    };
  }

  const onRequests = rules
    .map((rule) => rule.onRequest)
    .filter((onRequest): onRequest is NonNullable<ProxyRule["onRequest"]> => Boolean(onRequest));
  if (onRequests.length > 0) {
    composed.onRequest = async (ctx) => {
      for (const onRequest of onRequests) {
        const result = await onRequest(ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    };
  }

  const modifyRequestBodies = rules
    .map((rule) => rule.modifyRequestBody)
    .filter((modifyRequestBody): modifyRequestBody is NonNullable<ProxyRule["modifyRequestBody"]> => Boolean(modifyRequestBody));
  if (modifyRequestBodies.length > 0) {
    composed.modifyRequestBody = async (body, ctx) => {
      let nextBody = body;
      for (const modifyRequestBody of modifyRequestBodies) {
        const modified = await modifyRequestBody(nextBody, ctx);
        if (modified !== undefined) nextBody = modified;
      }
      return nextBody;
    };
  }

  const onResponses = rules
    .map((rule) => rule.onResponse)
    .filter((onResponse): onResponse is NonNullable<ProxyRule["onResponse"]> => Boolean(onResponse));
  if (onResponses.length > 0) {
    composed.onResponse = async (ctx) => {
      for (const onResponse of onResponses) {
        await onResponse(ctx);
      }
    };
  }

  const modifyResponseBodies = rules
    .map((rule) => rule.modifyResponseBody)
    .filter((modifyResponseBody): modifyResponseBody is NonNullable<ProxyRule["modifyResponseBody"]> => Boolean(modifyResponseBody));
  if (modifyResponseBodies.length > 0) {
    composed.modifyResponseBody = async (body, ctx) => {
      let nextBody = body;
      for (const modifyResponseBody of modifyResponseBodies) {
        const modified = await modifyResponseBody(nextBody, ctx);
        if (modified !== undefined) nextBody = modified;
      }
      return nextBody;
    };
  }

  return composed;
}

export class PluginRegistry {
  private entries: RegistryEntry[] = [];
  private globalEntries: GlobalRegistryEntry[] = [];
  private ignoreSubDomains: string[];

  constructor(ignoreSubDomains: string[] = ["www"]) {
    this.ignoreSubDomains = ignoreSubDomains;
  }

  /** Replace entire registry atomically (used during hot reload). */
  replace(plugins: DiscoveredPlugin[]): void {
    this.entries = plugins
      .filter((p) => p.kind !== "global")
      .map((p, order) => ({
        domain: p.domain.toLowerCase(),
        rule: p.rule,
        priority: p.rule.priority ?? 0,
        order,
      }));
    // Sort descending by priority so the first match wins in find()
    this.entries.sort(compareEntriesByPriorityThenOrder);

    this.globalEntries = plugins
      .filter((p) => p.kind === "global")
      .map((p, order) => ({
        id: p.name,
        rule: p.rule,
        priority: p.rule.priority ?? 0,
        order,
      }))
      .sort(compareEntriesByPriorityThenOrder);
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

  async resolveHttpRule(
    rawHost: string,
    req: http.IncomingMessage,
  ): Promise<ResolvedHttpRule> {
    const hostname = extractHostname(rawHost);
    const domain = normalizeHostname(hostname, this.ignoreSubDomains);
    const url = buildRequestUrl(req);
    const domainRule = this.resolve(rawHost);

    const matchedGlobals: GlobalRegistryEntry[] = [];
    for (const entry of this.globalEntries) {
      if (await matchesGlobalRule(entry.rule, url, req)) {
        matchedGlobals.push(entry);
      }
    }

    if (matchedGlobals.length === 0) {
      return {
        domain,
        url,
        rule: domainRule,
        matchedGlobalIds: [],
      };
    }

    const composedRules = [...matchedGlobals.map((entry) => entry.rule)];
    if (domainRule) composedRules.push(domainRule);

    return {
      domain,
      url,
      rule: composeHttpRules(composedRules),
      matchedGlobalIds: matchedGlobals.map((entry) => entry.id),
    };
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
