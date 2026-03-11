#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const cliOutputPath = resolve(distDir, "index.js");
const cliShebang = "#!/usr/bin/env bun";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

run("bun", ["build", "src/index.ts", "--target", "bun", "--outdir", "dist", "--entry-naming", "index.js"]);
run("bun", ["build", "src/types.ts", "--target", "bun", "--outdir", "dist", "--entry-naming", "types.js"]);
run("bun", ["run", "--bun", "tsc", "-p", "tsconfig.build.json"]);

const cliOutput = readFileSync(cliOutputPath, "utf8");
if (!cliOutput.startsWith(cliShebang)) {
  writeFileSync(cliOutputPath, `${cliShebang}\n${cliOutput}`);
}
chmodSync(cliOutputPath, 0o755);
