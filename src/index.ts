#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../package.json") as { version: string; description: string };

import { registerTlsCommand } from "./commands/tls.ts";
import { registerServeCommand } from "./commands/serve.ts";

const program = new Command();

program
  .name("proxy-rules")
  .description(pkg.description)
  .version(pkg.version);

registerTlsCommand(program);
registerServeCommand(program);

program.parse(process.argv);
