import http from "node:http";
import fs from "node:fs/promises";
import nodePath from "node:path";
import type { ContextHelpers } from "./types.ts";

const TEXT_CONTENT_TYPES = ["text/", "application/json", "application/xml", "application/xhtml"];
const MAX_BODY_LINES = 200;
const BASE64_LINE_WIDTH = 76;

export function buildRequestUrl(req: http.IncomingMessage): string {
  const reqUrl = req.url ?? "/";
  const absoluteUrl = reqUrl.startsWith("http://") || reqUrl.startsWith("https://")
    ? reqUrl
    : `${(req.socket as { encrypted?: boolean }).encrypted ? "https" : "http"}://${req.headers["host"] ?? "localhost"}${reqUrl}`;

  try {
    const parsed = new URL(absoluteUrl);
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return absoluteUrl;
  }
}

function escapeShellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const normalized = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return TEXT_CONTENT_TYPES.some((t) => normalized.includes(t));
}

function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const normalized = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.includes("application/json");
}

/** Splits a string into chunks of `width` characters (for base64 wrapping). */
function chunkString(s: string, width: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width));
  return chunks;
}

/**
 * Format a body for display in toCurl verbose output.
 * - JSON       → pretty-printed JSON
 * - text/*     → raw text
 * - binary     → base64 wrapped at 76 chars
 * Text and base64 are truncated at MAX_BODY_LINES lines.
 */
function formatBody(body: string | Buffer, contentType: string | undefined): string {
  let lines: string[];

  if (isJsonContentType(contentType)) {
    try {
      const pretty = JSON.stringify(JSON.parse(body.toString("utf-8")), null, 2);
      lines = pretty.split("\n");
    } catch {
      lines = body.toString("utf-8").split("\n");
    }
  } else if (isTextContentType(contentType)) {
    lines = body.toString("utf-8").split("\n");
  } else {
    // Binary → base64
    const b64 = (body instanceof Buffer ? body : Buffer.from(body as string, "utf-8")).toString("base64");
    lines = chunkString(b64, BASE64_LINE_WIDTH);
  }

  const truncated = lines.length > MAX_BODY_LINES;
  const display = truncated ? lines.slice(0, MAX_BODY_LINES) : lines;
  const suffix = truncated ? `\n... (${lines.length - MAX_BODY_LINES} more lines truncated)` : "";
  return display.join("\n") + suffix;
}

function toCurl(
  req: http.IncomingMessage,
  res?: http.IncomingMessage | http.ServerResponse,
): string {
  const url = buildRequestUrl(req);
  const method = req.method ?? "GET";
  const parts: string[] = [`curl -v ${escapeShellArg(url)}`];

  if (method !== "GET") parts.push(`-X ${method}`);

  for (const [key, val] of Object.entries(req.headers)) {
    if (val !== undefined) {
      parts.push(`-H ${escapeShellArg(`${key}: ${Array.isArray(val) ? val.join(", ") : val}`)}`);
    }
  }

  const reqBodyStored = (req as http.IncomingMessage & { _body?: string })._body;
  if (reqBodyStored !== undefined) {
    parts.push(`--data-raw ${escapeShellArg(reqBodyStored)}`);
  }

  const curlCmd = parts.join(" \\\n  ");
  if (!res) return curlCmd;

  // Append simulated curl -v verbose output showing request + response lines
  const parsed = new URL(url);
  const lines: string[] = [
    `${curlCmd.replace(/\n/g, "\n  ")}`,
    "",
    `> ${method} ${parsed.pathname}${parsed.search} HTTP/1.1`,
  ];
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) lines.push(`> ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  lines.push(">");

  if (reqBodyStored !== undefined) {
    const reqCt = req.headers["content-type"];
    lines.push(formatBody(reqBodyStored, reqCt));
    lines.push("");
  }

  let resContentType: string | undefined;
  if (res instanceof http.IncomingMessage) {
    lines.push(`< HTTP/${res.httpVersion} ${res.statusCode ?? ""} ${res.statusMessage ?? ""}`);
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) lines.push(`< ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    resContentType = typeof res.headers["content-type"] === "string"
      ? res.headers["content-type"]
      : undefined;
  } else {
    lines.push(`< HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ""}`);
    for (const [k, v] of Object.entries(res.getHeaders())) {
      if (v !== undefined) lines.push(`< ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    }
    const ct = res.getHeader("content-type");
    resContentType = typeof ct === "string" ? ct : undefined;
  }
  const resBodyStored = res ? (res as (http.IncomingMessage | http.ServerResponse) & { _body?: string })._body : undefined;
  lines.push("<");

  if (resBodyStored !== undefined) {
    lines.push("");
    lines.push(formatBody(resBodyStored, resContentType));
  }

  return lines.join("\n");
}

function toFetch(
  req: http.IncomingMessage,
): { url: string; options: { method: string; headers: Record<string, string> } } {
  const url = buildRequestUrl(req);
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val !== undefined) headers[key] = Array.isArray(val) ? val.join(", ") : val;
  }
  return { url, options: { method: req.method ?? "GET", headers } };
}

function toJson(
  reqOrRes: http.IncomingMessage | http.ServerResponse,
): Record<string, unknown> {
  if (reqOrRes instanceof http.IncomingMessage) {
    return {
      method: reqOrRes.method,
      url: reqOrRes.url,
      httpVersion: reqOrRes.httpVersion,
      statusCode: reqOrRes.statusCode,
      statusMessage: reqOrRes.statusMessage,
      headers: reqOrRes.headers,
    };
  }
  return {
    statusCode: reqOrRes.statusCode,
    statusMessage: reqOrRes.statusMessage,
    headers: reqOrRes.getHeaders(),
  };
}

async function saveTo(filePath: string, data: string | object): Promise<void> {
  await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, content, "utf-8");
}

export function createContextHelpers(): ContextHelpers {
  return { toCurl, toFetch, toJson, saveTo };
}
