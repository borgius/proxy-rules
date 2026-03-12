# Agents

This file defines the agents available for this project.

## Debug Mode Instructions

Primary objective is to systematically identify, analyze, and resolve bugs in the proxy-rules application.

## Explore

Fast read-only codebase exploration and Q&A subagent. Use for searching code, understanding structure, etc.

---

## Project Notes

### Context helpers (`src/plugins/context-helpers.ts`)

A `helpers: ContextHelpers` object is injected into every `ResponseContext` (and `BodyContext` which extends it). Available in the `onResponse` and `modifyResponseBody` plugin hooks.

| Helper | Signature | Notes |
|---|---|---|
| `toCurl` | `(req, res?) → string` | Produces a `curl -v` command. When `res` is supplied, also appends `>` / `<` verbose header lines. Bodies are read automatically from `_body` properties set on the objects by the pipeline (JSON is pretty-printed, text is raw, binary is base64-encoded, truncated at 200 lines). |
| `toFetch` | `(req) → { url, options }` | Returns fetch-ready params (method + headers). |
| `toJson` | `(req\|res) → object` | Serialises method/url/headers (requests) or statusCode/headers (responses). |
| `saveTo` | `(path, string\|object) → Promise<void>` | Writes to file; objects are pretty-printed JSON. Parent dirs created automatically. |

When adding new context-level utilities, implement them in `context-helpers.ts`, declare the signature in the `ContextHelpers` interface in `src/plugins/types.ts`, and inject via `createContextHelpers()` at each call site in `response-pipeline.ts` and `http-handler.ts`.

**Tests:** `tests/context-helpers.test.ts` — unit tests covering all four helpers (no network required).
