import { z } from "zod";

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("pretty"),
  outputPath: z.string().optional(),
  /** Max bytes of request/response body to capture. 0 = no body capture. */
  maxBodyBytes: z.number().int().nonnegative().default(4096),
}).default({});

export const ProxyConfigSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default("0.0.0.0"),
  /**
   * Subdomains stripped from the hostname before plugin lookup.
   * e.g. ["www"] causes www.example.com → example.com
   */
  ignoreSubDomains: z.array(z.string()).default(["www"]),
  logging: LoggingConfigSchema,
  pluginHotReload: z.boolean().default(true),
  /** Timeout in ms for upstream connections */
  upstreamTimeout: z.number().int().positive().default(30_000),
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
