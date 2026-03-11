import chokidar from "chokidar";
import type { PluginRegistry } from "../plugins/plugin-registry.ts";
import { discoverPlugins } from "../plugins/discover-plugins.ts";
import { getLogger } from "../logging/logger.ts";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Watch the `rulesDir` directory for changes and atomically reload the
 * plugin registry when files are added, changed, or removed.
 *
 * In-flight requests will continue using the old registry snapshot because
 * the registry is replaced atomically (not mutated in place).
 */
export function watchRules(rulesDir: string, registry: PluginRegistry): chokidar.FSWatcher {
  const logger = getLogger();

  const watcher = chokidar.watch(rulesDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const reload = async () => {
    logger.info("Rules changed — reloading plugin registry…");
    try {
      const plugins = await discoverPlugins(rulesDir);
      registry.replace(plugins);
      logger.info(`Plugin registry reloaded: ${registry.size} domain(s)`, {
        domains: registry.domains(),
      });
    } catch (err) {
      logger.error("Failed to reload plugin registry", {
        error: (err as Error).message,
      });
    }
  };

  const debounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, 500);
  };

  watcher.on("add", debounced);
  watcher.on("change", debounced);
  watcher.on("unlink", debounced);
  watcher.on("addDir", debounced);
  watcher.on("unlinkDir", debounced);

  watcher.on("error", (err) => {
    logger.error("File watcher error", { error: (err as Error).message });
  });

  logger.debug("Watching rules directory for changes", { rulesDir });

  return watcher;
}
