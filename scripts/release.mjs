#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(rootDir, "package.json");
const requestedVersion = process.argv[2] ?? "patch";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.captureOutput ? "pipe" : "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

const gitStatus = run("git", ["status", "--porcelain"], { captureOutput: true }).stdout.trim();
if (gitStatus.length > 0) {
  process.stderr.write("Release aborted: git working tree must be clean before publishing.\n");
  process.exit(1);
}

const gitBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { captureOutput: true }).stdout.trim();
if (gitBranch === "HEAD") {
  process.stderr.write("Release aborted: detached HEAD is not supported.\n");
  process.exit(1);
}

run("bun", ["run", "test"]);
run("bun", ["run", "typecheck"]);
run("npm", ["version", requestedVersion, "--no-git-tag-version"]);
run("bun", ["run", "build"]);
run("npm", ["publish"]);

const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const tagName = `v${version}`;

run("git", ["add", "package.json"]);
run("git", ["commit", "-m", `release: ${tagName}`]);
run("git", ["tag", tagName]);
run("git", ["push", "origin", "HEAD", "--follow-tags"]);

process.stdout.write(`\nReleased ${tagName} successfully.\n`);
