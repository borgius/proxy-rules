import { describe, expect, test } from "vitest";
import { normalizeHostname, extractHostname } from "../src/plugins/plugin-registry.ts";

describe("normalizeHostname", () => {
  test("strips single configured subdomain", () => {
    expect(normalizeHostname("www.example.com", ["www"])).toBe("example.com");
  });

  test("does not strip non-configured subdomain", () => {
    expect(normalizeHostname("api.example.com", ["www"])).toBe("api.example.com");
  });

  test("strips alternate configured subdomain", () => {
    expect(normalizeHostname("m.example.com", ["www", "m"])).toBe("example.com");
  });

  test("single label hostname is unchanged", () => {
    expect(normalizeHostname("localhost", ["www"])).toBe("localhost");
  });

  test("leaves deeply nested subdomains unchanged", () => {
    expect(normalizeHostname("a.b.example.com", ["www"])).toBe("a.b.example.com");
  });

  test("is case-insensitive", () => {
    expect(normalizeHostname("WWW.Example.COM", ["www"])).toBe("example.com");
  });

  test("empty ignoreSubDomains list → no stripping", () => {
    expect(normalizeHostname("www.example.com", [])).toBe("www.example.com");
  });
});

describe("extractHostname", () => {
  test("strips port from hostname", () => {
    expect(extractHostname("example.com:8080")).toBe("example.com");
  });

  test("handles hostname without port", () => {
    expect(extractHostname("example.com")).toBe("example.com");
  });

  test("handles IPv6 with port", () => {
    expect(extractHostname("[::1]:8080")).toBe("[::1]");
  });

  test("handles IPv6 without port", () => {
    expect(extractHostname("[::1]")).toBe("[::1]");
  });
});
