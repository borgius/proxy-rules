import type { Command } from "commander";
import picocolors from "picocolors";
import { existsSync, mkdirSync } from "node:fs";
import { ensureCa } from "../tls/ca-store.ts";
import { tryInstallMacosTrust } from "../tls/trust-macos.ts";
import { loadConfig } from "../config/load-config.ts";
import { initLogger, getLogger } from "../logging/logger.ts";

export function registerTlsCommand(program: Command): void {
  program
    .command("tls")
    .description("Create the local CA certificate and attempt to install it as a trusted root")
    .option("--config <path>", "Config root directory")
    .action(async (opts: { config?: string }) => {
      const { config, paths } = loadConfig({ configDir: opts.config });
      initLogger(config.logging);
      const logger = getLogger();

      logger.info("proxy-rules tls — initialising certificate authority");

      // Ensure directories exist
      for (const dir of [paths.certsDir, paths.certsDomainDir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
          logger.debug(`Created directory: ${dir}`);
        }
      }

      const { created } = ensureCa(paths.caCertPath, paths.caKeyPath);

      if (created) {
        logger.info(`CA certificate created at ${picocolors.cyan(paths.caCertPath)}`);
      } else {
        logger.info(`CA certificate already exists at ${picocolors.cyan(paths.caCertPath)}`);
      }

      if (process.platform !== "darwin") {
        process.stdout.write(
          [
            "",
            picocolors.bold("Manual trust installation required."),
            `CA cert path: ${picocolors.cyan(paths.caCertPath)}`,
            "",
            "Add this certificate to your OS / browser trust store.",
            "On Linux with NSS (Chrome/Chromium/Firefox):",
            `  ${picocolors.cyan(`certutil -d sql:$HOME/.pki/nssdb -A -t "CT,," -n "proxy-rules CA" -i "${paths.caCertPath}"`)}`,
            "",
          ].join("\n"),
        );
        return;
      }

      // macOS: attempt automatic trust
      const result = tryInstallMacosTrust(paths.caCertPath);
      if (result.success) {
        process.stdout.write(
          [
            "",
            picocolors.green("✔  " + result.message),
            "",
            "Restart your browser to pick up the new trust anchor.",
            `CA cert: ${picocolors.cyan(paths.caCertPath)}`,
            "",
          ].join("\n"),
        );
      } else {
        process.stdout.write("\n" + result.message + "\n");
      }
    });
}
