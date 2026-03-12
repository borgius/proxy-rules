import { describe, expect, test, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { createContextHelpers } from "../src/plugins/context-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers to build minimal IncomingMessage / ServerResponse mocks
// ---------------------------------------------------------------------------

function makeIncomingReq(overrides: Partial<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  httpVersion: string;
  statusCode: number;
  statusMessage: string;
}> = {}): http.IncomingMessage {
  const req = new http.IncomingMessage(createServer().listen(0) as never);
  req.method = overrides.method ?? "GET";
  req.url = overrides.url ?? "/path?q=1";
  req.headers = {
    host: "example.com",
    accept: "application/json",
    ...(overrides.headers ?? {}),
  };
  req.httpVersion = overrides.httpVersion ?? "1.1";
  if (overrides.statusCode !== undefined) req.statusCode = overrides.statusCode;
  if (overrides.statusMessage !== undefined) req.statusMessage = overrides.statusMessage;
  return req;
}

function makeIncomingRes(overrides: Partial<{
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  httpVersion: string;
}> = {}): http.IncomingMessage {
  const res = new http.IncomingMessage(createServer().listen(0) as never);
  res.statusCode = overrides.statusCode ?? 200;
  res.statusMessage = overrides.statusMessage ?? "OK";
  res.httpVersion = overrides.httpVersion ?? "1.1";
  res.headers = { "content-type": "application/json", ...(overrides.headers ?? {}) };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const helpers = createContextHelpers();

describe("createContextHelpers", () => {
  // ── toCurl ──────────────────────────────────────────────────────────────

  describe("toCurl", () => {
    test("produces a curl -v command with URL and headers", () => {
      const req = makeIncomingReq({ method: "GET" });
      const result = helpers.toCurl(req);

      expect(result).toContain("curl -v");
      expect(result).toContain("example.com");
      expect(result).toContain("-H 'accept: application/json'");
      expect(result).toContain("-H 'host: example.com'");
      // GET should NOT produce -X flag
      expect(result).not.toContain("-X GET");
    });

    test("includes -X <METHOD> for non-GET requests", () => {
      const req = makeIncomingReq({ method: "POST" });
      const result = helpers.toCurl(req);

      expect(result).toContain("-X POST");
    });

    test("escapes single quotes in header values", () => {
      const req = makeIncomingReq({ headers: { host: "example.com", "x-title": "it's alive" } });
      const result = helpers.toCurl(req);

      // The full -H argument for 'it'\''s alive' escapes using the shell '\'' technique
      expect(result).toContain("-H 'x-title: it'\\''s alive'");
    });

    test("builds absolute URL from host header + relative path", () => {
      const req = makeIncomingReq({ url: "/api/v1?foo=bar", headers: { host: "api.example.com" } });
      const result = helpers.toCurl(req);

      expect(result).toContain("http://api.example.com/api/v1?foo=bar");
    });

    test("keeps absolute URL when request already has one", () => {
      const req = makeIncomingReq({ url: "https://upstream.internal/path" });
      const result = helpers.toCurl(req);

      expect(result).toContain("https://upstream.internal/path");
    });

    test("includes verbose request+response lines when proxyRes is supplied", () => {
      const req = makeIncomingReq({ method: "DELETE", url: "/resource/1" });
      const res = makeIncomingRes({ statusCode: 204, statusMessage: "No Content" });

      const result = helpers.toCurl(req, res);

      // curl command appears at the top
      expect(result).toContain("curl -v");
      // request line
      expect(result).toContain("> DELETE /resource/1 HTTP/1.1");
      // response status line
      expect(result).toContain("< HTTP/1.1 204 No Content");
      // response headers
      expect(result).toContain("< content-type: application/json");
    });

    test("returns only the curl command (no > / < lines) when no res is provided", () => {
      const req = makeIncomingReq();
      const result = helpers.toCurl(req);

      expect(result).not.toContain(">");
      expect(result).not.toContain("<");
    });

    test("includes --data-raw in curl command when reqBody is provided", () => {
      const req = makeIncomingReq({
        method: "POST",
        headers: { host: "example.com", "content-type": "application/json" },
      });
      (req as any)._body = '{"key":"value"}';
      const result = helpers.toCurl(req);

      expect(result).toContain("--data-raw");
      expect(result).toContain('{"key":"value"}');
    });

    test("pretty-prints JSON request body in verbose output", () => {
      const req = makeIncomingReq({
        method: "POST",
        headers: { host: "example.com", "content-type": "application/json" },
      });
      const res = makeIncomingRes({ statusCode: 200, statusMessage: "OK" });
      (req as any)._body = '{"a":1,"b":2}';
      const result = helpers.toCurl(req, res);

      // pretty JSON has keys on their own lines
      expect(result).toContain('  "a": 1');
      expect(result).toContain('  "b": 2');
    });

    test("pretty-prints JSON response body in verbose output", () => {
      const req = makeIncomingReq();
      const res = makeIncomingRes({
        statusCode: 200,
        headers: { "content-type": "application/json" },
      });
      (res as any)._body = '[{"id":1},{"id":2}]';
      const result = helpers.toCurl(req, res);

      expect(result).toContain('  {');
      expect(result).toContain('"id": 1');
    });

    test("prints text response body as-is", () => {
      const req = makeIncomingReq();
      const res = makeIncomingRes({
        statusCode: 200,
        headers: { "content-type": "text/plain" },
      });
      (res as any)._body = "hello from server";
      const result = helpers.toCurl(req, res);

      expect(result).toContain("hello from server");
    });

    test("encodes binary response body as base64", () => {
      const req = makeIncomingReq();
      const res = makeIncomingRes({
        statusCode: 200,
        headers: { "content-type": "image/png" },
      });
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      (res as any)._body = binaryData;
      const result = helpers.toCurl(req, res);

      const expected = binaryData.toString("base64");
      expect(result).toContain(expected);
    });

    test("truncates body output at 200 lines", () => {
      const req = makeIncomingReq();
      const res = makeIncomingRes({
        statusCode: 200,
        headers: { "content-type": "text/plain" },
      });
      const bigBody = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
      (res as any)._body = bigBody;
      const result = helpers.toCurl(req, res);

      expect(result).toContain("line 200");
      expect(result).not.toContain("line 201");
      expect(result).toContain("50 more lines truncated");
    });
  });

  // ── toFetch ──────────────────────────────────────────────────────────────

  describe("toFetch", () => {
    test("returns url and method", () => {
      const req = makeIncomingReq({ method: "PATCH", url: "/items/7" });
      const { url, options } = helpers.toFetch(req);

      expect(url).toContain("/items/7");
      expect(options.method).toBe("PATCH");
    });

    test("collects all request headers into options.headers", () => {
      const req = makeIncomingReq({
        headers: { host: "example.com", authorization: "Bearer tok", "x-custom": "yes" },
      });
      const { options } = helpers.toFetch(req);

      expect(options.headers["host"]).toBe("example.com");
      expect(options.headers["authorization"]).toBe("Bearer tok");
      expect(options.headers["x-custom"]).toBe("yes");
    });

    test("joins array header values with ', '", () => {
      const req = makeIncomingReq({ headers: { host: "example.com", "x-multi": ["a", "b"] } });
      const { options } = helpers.toFetch(req);

      expect(options.headers["x-multi"]).toBe("a, b");
    });

    test("builds correct absolute URL for relative paths", () => {
      const req = makeIncomingReq({
        url: "/search?q=proxy",
        headers: { host: "search.example.com" },
      });
      const { url } = helpers.toFetch(req);

      expect(url).toBe("http://search.example.com/search?q=proxy");
    });
  });

  // ── toJson ───────────────────────────────────────────────────────────────

  describe("toJson", () => {
    test("converts IncomingMessage (request) to plain object", () => {
      const req = makeIncomingReq({ method: "PUT", url: "/obj/5", headers: { host: "x.com" } });
      const json = helpers.toJson(req);

      expect(json["method"]).toBe("PUT");
      expect(json["url"]).toBe("/obj/5");
      expect((json["headers"] as Record<string, string>)["host"]).toBe("x.com");
      expect(json["httpVersion"]).toBe("1.1");
    });

    test("converts IncomingMessage (response) to plain object with status", () => {
      const res = makeIncomingRes({ statusCode: 404, statusMessage: "Not Found" });
      const json = helpers.toJson(res);

      expect(json["statusCode"]).toBe(404);
      expect(json["statusMessage"]).toBe("Not Found");
      expect((json["headers"] as Record<string, string>)["content-type"]).toBe("application/json");
    });

    test("serialises cleanly to JSON without circular refs", () => {
      const req = makeIncomingReq();
      expect(() => JSON.stringify(helpers.toJson(req))).not.toThrow();
    });
  });

  // ── saveTo ───────────────────────────────────────────────────────────────

  describe("saveTo", () => {
    const tmpBase = nodePath.join(os.tmpdir(), "context-helpers-test");

    afterEach(async () => {
      await fs.rm(tmpBase, { recursive: true, force: true });
    });

    test("writes a string to a file and creates parent directories", async () => {
      const filePath = nodePath.join(tmpBase, "nested", "dir", "output.txt");
      await helpers.saveTo(filePath, "hello world");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello world");
    });

    test("serialises an object as pretty JSON (2-space indent)", async () => {
      const filePath = nodePath.join(tmpBase, "data.json");
      await helpers.saveTo(filePath, { key: "value", num: 42 });

      const content = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(content)).toEqual({ key: "value", num: 42 });
      // verify pretty-printed (has newlines / spaces)
      expect(content).toContain("\n  ");
    });

    test("overwrites an existing file", async () => {
      const filePath = nodePath.join(tmpBase, "overwrite.txt");
      await helpers.saveTo(filePath, "first");
      await helpers.saveTo(filePath, "second");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("second");
    });
  });
});
