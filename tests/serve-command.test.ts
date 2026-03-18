import { afterEach, describe, expect, test } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerServeCommand, stopActiveServeRuntime } from "../src/commands/serve.ts";

function createTempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function createServeFixture(): { workspaceDir: string; configDir: string; rulesDir: string } {
  const workspaceDir = createTempDir("proxy-rules-serve");
  const configDir = join(workspaceDir, ".proxy-rules");
  const rulesDir = join(configDir, "rules");

  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 8080,
      pluginHotReload: false,
      logging: {
        level: "error",
        format: "json",
        maxBodyBytes: 0,
      },
    }),
  );

  return { workspaceDir, configDir, rulesDir };
}

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

afterEach(async () => {
  await stopActiveServeRuntime();
});

describe("registerServeCommand", () => {
  test("restarting serve on the same port replaces the previous active runtime", async () => {
    const { workspaceDir, configDir, rulesDir } = createServeFixture();
    const port = await getFreePort();

    try {
      const program = new Command();
      registerServeCommand(program);

      await program.parseAsync([
        "node",
        "proxy-rules",
        "serve",
        "--config",
        configDir,
        "--rules",
        rulesDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ]);

      await expect(
        program.parseAsync([
          "node",
          "proxy-rules",
          "serve",
          "--config",
          configDir,
          "--rules",
          rulesDir,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ]),
      ).resolves.toBe(program);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
