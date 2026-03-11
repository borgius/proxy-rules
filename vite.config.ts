import { defineConfig } from "vitest/config";
import { builtinModules } from "node:module";

// All runtime dependencies are kept external so the dist stays thin.
const runtimeDeps = [
  "http-proxy",
  "node-forge",
  "commander",
  "zod",
  "picocolors",
  "chokidar",
];

const external = [
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
  ...runtimeDeps,
];

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        index: "src/index.ts",
        types: "src/types.ts",
      },
      external,
      output: {
        format: "esm",
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
});
