import http from "node:http";
import type net from "node:net";
import type { Command } from "commander";
import picocolors from "picocolors";
import { loadConfig } from "../config/load-config.ts";
import { initLogger, getLogger } from "../logging/logger.ts";
import { buildRegistry } from "../plugins/plugin-registry.ts";
import { ensureCa } from "../tls/ca-store.ts";
import { createProxyServer } from "../proxy/create-http-proxy.ts";
import { handleHttpRequest } from "../proxy/http-handler.ts";
import { handleConnect } from "../proxy/connect-handler.ts";
import { handleWebSocketUpgrade } from "../proxy/websocket-handler.ts";
import { watchRules } from "../watch/watch-config-and-rules.ts";
import { existsSync } from "node:fs";
import type { CaAssets } from "../tls/ca-store.ts";

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the MITM proxy server")
    .option("--config <path>", "Config root directory")
    .option("--rules <path>", "Rules directory override")
    .option("--port <n>", "Listening port", (v) => parseInt(v, 10))
    .option("--host <addr>", "Bind address")
    .action(async (opts: { config?: string; rules?: string; port?: number; host?: string }) => {
      const { config, paths } = loadConfig({
        configDir: opts.config,
        rulesDir: opts.rules,
        overrides: {
          port: opts.port,
          host: opts.host,
        },
      });

      initLogger(config.logging);
      const logger = getLogger();

      // Warn if CA does not exist
      if (!existsSync(paths.caCertPath)) {
        logger.warn(
          "CA certificate not found. Run `proxy-rules tls` first to enable HTTPS MITM.",
          { path: paths.caCertPath },
        );
      }

      // Load CA (required for CONNECT MITM; if missing we still serve plain HTTP)
      let ca: CaAssets | undefined;
      try {
        ca = ensureCa(paths.caCertPath, paths.caKeyPath);
      } catch (err) {
        logger.warn("Could not load CA: HTTPS CONNECT will not be intercepted", {
          error: (err as Error).message,
        });
      }

      // Build plugin registry
      const registry = await buildRegistry(paths.rulesDir, config.ignoreSubDomains);

      // Start hot reload
      if (config.pluginHotReload) {
        watchRules(paths.rulesDir, registry);
      }

      // Create proxy engine
      const proxy = createProxyServer();

      // Main HTTP/proxy server
      const server = http.createServer((req, res) => {
        handleHttpRequest(req, res, proxy, registry, config, ca);
      });

      // WebSocket upgrade
      server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        handleWebSocketUpgrade(req, socket, head, proxy, registry, config);
      });

      // HTTPS CONNECT MITM
      server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        if (!ca) {
          logger.warn("CONNECT request received but CA is not available — dropping", {
            authority: req.url,
          });
          socket.write("HTTP/1.1 502 CA Not Available\r\n\r\n");
          socket.destroy();
          return;
        }
        handleConnect(req, socket, head, proxy, registry, config, ca, paths).catch((err) => {
          logger.error("CONNECT handler error", { error: (err as Error).message });
          socket.destroy();
        });
      });

      server.listen(config.port, config.host, () => {
        const addr = `${config.host}:${config.port}`;
        const configSources = paths.configFiles.length > 0
          ? paths.configFiles.map((file) => `    - ${picocolors.dim(file)}`).join("\n")
          : `    - ${picocolors.dim(paths.configFile)}`;

        process.stdout.write(
          [
            "",
            `${picocolors.green("✔")} proxy-rules listening on ${picocolors.cyan(`http://${addr}`)}`,
            "",
            "  Configure your browser or system proxy:",
            `    HTTP Proxy:  ${picocolors.cyan(addr)}`,
            `    HTTPS Proxy: ${picocolors.cyan(addr)}`,
            "",
            `  Rules directory: ${picocolors.dim(paths.rulesDir)}`,
            "  Config files:",
            configSources,
            "",
            "  Press Ctrl+C to stop.",
            "",
          ].join("\n"),
        );
      });

      const gracefulShutdown = () => {
        logger.info("Shutting down…");
        server.close(() => {
          proxy.close();
          process.exit(0);
        });
      };

      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);
    });
}
