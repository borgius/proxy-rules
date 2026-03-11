import { describe, expect, test, afterAll } from "bun:test";
import { ensureCa } from "../src/tls/ca-store.ts";
import { getDomainCert } from "../src/tls/cert-generator.ts";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

const TMP_DIR = join("/tmp", "__proxy_rules_tls_test__");
const CA_CERT = join(TMP_DIR, "ca-cert.pem");
const CA_KEY = join(TMP_DIR, "ca-key.pem");
const DOMAINS_DIR = join(TMP_DIR, "domains");

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true });
  }
});

describe("ensureCa", () => {
  test("creates CA files on first call", () => {
    const result = ensureCa(CA_CERT, CA_KEY);
    expect(result.created).toBe(true);
    expect(existsSync(CA_CERT)).toBe(true);
    expect(existsSync(CA_KEY)).toBe(true);
    expect(result.caCertPem).toMatch(/BEGIN CERTIFICATE/);
    expect(result.caKeyPem).toMatch(/BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY/);
  });

  test("is idempotent — reuses existing CA on second call", () => {
    const first = ensureCa(CA_CERT, CA_KEY);
    const second = ensureCa(CA_CERT, CA_KEY);
    expect(second.created).toBe(false);
    // PEM content should be identical
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.caKeyPem).toBe(first.caKeyPem);
  });

  test("generated CA cert is self-signed and is marked as a CA", () => {
    const { caCert } = ensureCa(CA_CERT, CA_KEY);
    expect(caCert.isIssuer(caCert)).toBe(true);

    const bcExt = caCert.getExtension("basicConstraints") as { cA?: boolean } | null;
    expect(bcExt?.cA).toBe(true);
  });
});

describe("getDomainCert", () => {
  test("generates a domain cert signed by the CA", () => {
    const ca = ensureCa(CA_CERT, CA_KEY);
    const domainCert = getDomainCert("test.local", DOMAINS_DIR, ca);

    expect(domainCert.certPem).toMatch(/BEGIN CERTIFICATE/);
    expect(domainCert.keyPem).toMatch(/BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY/);

    // Verify the cert is signed by our CA
    const cert = forge.pki.certificateFromPem(domainCert.certPem);
    expect(cert.isIssuer(ca.caCert) || ca.caCert.issued(cert)).toBe(true);
  });

  test("reuses cached domain cert", () => {
    const ca = ensureCa(CA_CERT, CA_KEY);
    const first = getDomainCert("cached.local", DOMAINS_DIR, ca);
    const second = getDomainCert("cached.local", DOMAINS_DIR, ca);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });

  test("generates distinct certs for distinct domains", () => {
    const ca = ensureCa(CA_CERT, CA_KEY);
    const a = getDomainCert("alpha.local", DOMAINS_DIR, ca);
    const b = getDomainCert("beta.local", DOMAINS_DIR, ca);
    expect(a.certPem).not.toBe(b.certPem);
  });
});
