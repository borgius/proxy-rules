---
name: Bun
description: Use when building JavaScript/TypeScript applications, managing dependencies, running tests, bundling code, or creating HTTP servers. Reach for Bun when you need a fast, all-in-one JavaScript runtime that replaces Node.js, npm, and build tools.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill

## Product summary

Bun is a fast, all-in-one JavaScript runtime that bundles a package manager, test runner, bundler, and transpiler into a single binary. It replaces Node.js, npm, and common build tools. Use Bun to execute TypeScript/JSX directly, manage dependencies with `bun install`, run tests with `bun test`, bundle code with `bun build`, and start HTTP servers with `Bun.serve()`. Key files: `package.json`, `bunfig.toml` (optional configuration), `bun.lock` (lockfile). Primary docs: https://bun.com/docs

## When to use

- **Running code**: Execute `.ts`, `.tsx`, `.js`, `.jsx` files directly without compilation steps
- **Managing dependencies**: Replace `npm install` with `bun install` for faster, Node.js-compatible package management
- **Testing**: Write and run tests with Jest-like syntax using `bun test`
- **Building**: Bundle JavaScript/TypeScript for browsers or create standalone executables with `bun build`
- **HTTP servers**: Build servers with `Bun.serve()` for high-performance request handling
- **File I/O**: Read/write files with optimized `Bun.file()` and `Bun.write()` APIs
- **Scripting**: Run shell commands and spawn child processes with `Bun.spawn()` and `$` shell syntax
- **Database**: Query SQLite with built-in `bun:sqlite` module
- **WebSockets**: Build real-time applications with native WebSocket support

## Quick reference

### Essential commands

| Task | Command |
|------|---------|
| Initialize project | `bun init` |
| Install dependencies | `bun install` or `bun i` |
| Add package | `bun add <package>` |
| Add dev dependency | `bun add -d <package>` |
| Remove package | `bun remove <package>` |
| Run script | `bun run <script>` or `bun <script>` |
| Run file | `bun <file.ts>` |
| Run with watch | `bun --watch <file.ts>` |
| Run tests | `bun test` |
| Run tests with watch | `bun --watch test` |
| Build bundle | `bun build <entry> --outdir <dir>` |
| Build executable | `bun build <entry> --compile --outfile <name>` |
| Start REPL | `bun` |

### Configuration file: bunfig.toml

Located at `./bunfig.toml` or `$HOME/.bunfig.toml`. Optional; Bun works without it.

```toml
[install]
optional = true          # Install optionalDependencies
dev = true              # Install devDependencies
peer = true             # Install peerDependencies
linker = "hoisted"      # "hoisted" or "isolated"
frozenLockfile = false  # Fail if lockfile changes

[test]
# Test runner configuration

[run]
# Runtime configuration for bun run
```

### File conventions

- **Entry points**: `index.ts`, `index.tsx`, `index.js`, `index.jsx`
- **Test files**: `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` (and `.js`, `.tsx`, `.jsx` variants)
- **Package manager**: `package.json`, `bun.lock` (auto-generated)
- **TypeScript**: `tsconfig.json` (auto-detected)

### Core APIs

| API | Purpose |
|-----|---------|
| `Bun.serve()` | Start HTTP server |
| `Bun.file()` | Read file as BunFile (extends Blob) |
| `Bun.write()` | Write file to disk |
| `Bun.spawn()` | Spawn child process |
| `fetch()` | HTTP client (standard Web API) |
| `Bun.env` | Access environment variables |
| `new SQL()` | Query SQLite database |
| `$` | Run shell commands (from `bun` module) |

## Decision guidance

### When to use X vs Y

| Scenario | Use | Why |
|----------|-----|-----|
| **Package manager** | `bun install` vs `npm install` | Bun is 20x faster, Node.js-compatible, reads `.npmrc` |
| **Script runner** | `bun run` vs `npm run` | Bun has 28x less overhead (6ms vs 170ms) |
| **HTTP server** | `Bun.serve()` vs Express | Bun.serve is native, faster; use Express for compatibility |
| **File I/O** | `Bun.file()` vs `fs.readFile()` | Bun.file is optimized; use `node:fs` for unsupported operations |
| **Bundler** | `bun build` vs esbuild | Bun bundles, transpiles, and compiles in one tool |
| **Test runner** | `bun test` vs Jest | Bun test is built-in, Jest-compatible, no setup needed |
| **Executable** | `bun build --compile` vs Docker | Single binary; Docker for multi-platform distribution |
| **Linker strategy** | `hoisted` vs `isolated` | Hoisted for compatibility; isolated for monorepos |

## Workflow

### 1. Start a new project
```bash
bun init my-app
cd my-app
```
Choose template: Blank, React, or Library. Creates `package.json`, `tsconfig.json`, entry point.

### 2. Install dependencies
```bash
bun install
# or add specific packages
bun add zod
bun add -d @types/node
```
Reads `package.json`, creates `bun.lock`, installs to `node_modules/`.

### 3. Write code
- Use TypeScript/JSX directly; no compilation step needed
- Import from `node_modules`, relative paths, or `node:` builtins
- Use Bun APIs: `Bun.serve()`, `Bun.file()`, `fetch()`, etc.

### 4. Run code
```bash
bun index.ts              # Run file directly
bun run dev              # Run package.json script
bun --watch index.ts     # Watch mode
```

### 5. Test
```bash
# Write tests in *.test.ts files
bun test                 # Run all tests
bun test --watch        # Watch mode
bun test -t "pattern"   # Filter by name
```

### 6. Build
```bash
# Bundle for browser/Node.js
bun build ./index.ts --outdir ./dist

# Create standalone executable
bun build ./cli.ts --compile --outfile mycli
./mycli
```

### 7. Deploy
- Executables: Copy binary to server, run directly
- Node.js: `bun build --format cjs` for CommonJS compatibility
- Docker: Use Bun base image, copy executable or source

## Common gotchas

- **Watch mode flag placement**: Use `bun --watch run dev`, not `bun run dev --watch`
- **Lockfile conflicts**: Don't manually edit `bun.lock`; use `bun install` to regenerate
- **SQLite paths**: Relative paths resolve to current working directory, not project root
- **Module resolution**: Bun supports both ESM and CommonJS; mixing works but can be confusing
- **Node.js compatibility**: Not 100% complete; check docs for unsupported APIs
- **Environment variables**: Load from `.env`, `.env.local`, `.env.[NODE_ENV]` automatically
- **Relative imports**: Always use `./` for relative paths; bare names resolve to `node_modules`
- **TypeScript config**: `tsconfig.json` is auto-detected; use `--tsconfig-override` to specify custom path
- **Test discovery**: Only files matching `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` are run
- **Workspaces**: Use `workspace:*` version specifier for internal dependencies, not relative paths
- **Bundler output**: `bun build` without `--outdir` or `--outfile` prints to stdout
- **Hot reload**: `--hot` flag re-runs entire file on change; use for development only

## Verification checklist

Before submitting work with Bun:

- [ ] Run `bun install` to verify dependencies resolve without errors
- [ ] Run `bun test` to ensure all tests pass
- [ ] Run `bun build` to verify bundling succeeds
- [ ] Check `bunfig.toml` for any custom config that should be documented
- [ ] Verify `package.json` scripts are correct and tested
- [ ] Test with `bun --watch` to confirm watch mode works
- [ ] If using TypeScript, verify `tsconfig.json` is present and valid
- [ ] If building executable, test with `bun build --compile` and run the binary
- [ ] Check for hardcoded paths; use relative paths or environment variables
- [ ] Verify `.env` files are in `.gitignore` if they contain secrets

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt
- **Runtime API reference**: https://bun.com/docs/runtime/bun-apis
- **Package manager docs**: https://bun.com/docs/pm/cli/install
- **Bundler guide**: https://bun.com/docs/bundler/index

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt