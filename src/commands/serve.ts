import http from "node:http";
import type net from "node:net";
import type { Command } from "commander";
import type { FSWatcher } from "chokidar";
import type httpProxy from "http-proxy";
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

interface ActiveServeRuntime {
  server: http.Server;
  proxy: httpProxy;
  watcher?: FSWatcher;
  shutdownHandler: () => void;
}

const ACTIVE_SERVE_RUNTIME_KEY = Symbol.for("proxy-rules.active-serve-runtime");

type GlobalWithActiveServeRuntime = typeof globalThis & {
  [ACTIVE_SERVE_RUNTIME_KEY]?: ActiveServeRuntime;
};

function getActiveServeRuntime(): ActiveServeRuntime | undefined {
  return (globalThis as GlobalWithActiveServeRuntime)[ACTIVE_SERVE_RUNTIME_KEY];
}

function setActiveServeRuntime(runtime: ActiveServeRuntime | undefined): void {
  const state = globalThis as GlobalWithActiveServeRuntime;

  if (runtime) {
    state[ACTIVE_SERVE_RUNTIME_KEY] = runtime;
    return;
  }

  delete state[ACTIVE_SERVE_RUNTIME_KEY];
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function stopActiveServeRuntime(): Promise<void> {
  const runtime = getActiveServeRuntime();
  if (!runtime) {
    return;
  }

  setActiveServeRuntime(undefined);
  process.off("SIGINT", runtime.shutdownHandler);
  process.off("SIGTERM", runtime.shutdownHandler);

  if (runtime.watcher) {
    await runtime.watcher.close();
  }

  await closeServer(runtime.server);
  runtime.proxy.close();
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the MITM proxy server")
    .option("--config <path>", "Config root directory")
    .option("--rules <path>", "Rules directory override")
    .option("--port <n>", "Listening port", (v) => parseInt(v, 10))
    .option("--host <addr>", "Bind address")
    .action(async (opts: { config?: string; rules?: string; port?: number; host?: string }) => {
      await stopActiveServeRuntime();

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
      let watcher: FSWatcher | undefined;
      if (config.pluginHotReload) {
        watcher = watchRules(paths.rulesDir, registry);
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

      const gracefulShutdown = () => {
        logger.info("Shutting down…");
        void stopActiveServeRuntime()
          .then(() => {
            process.exit(0);
          })
          .catch((err) => {
            logger.error("Failed to shut down cleanly", { error: (err as Error).message });
            process.exit(1);
          });
      };

      const runtime: ActiveServeRuntime = {
        server,
        proxy,
        watcher,
        shutdownHandler: gracefulShutdown,
      };

      setActiveServeRuntime(runtime);
      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);

      try {
        await listen(server, config.port, config.host);
      } catch (err) {
        await stopActiveServeRuntime();
        throw err;
      }

      {
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
      }
    });
}
