import forge from "node-forge";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CaAssets } from "./ca-store.ts";

interface DomainCert {
  certPem: string;
  keyPem: string;
}

const CERT_VALIDITY_DAYS = 825;

/** Generate a leaf TLS certificate for `domain` signed by the given CA. */
function generateDomainCert(domain: string, ca: CaAssets): DomainCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(20));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(
    cert.validity.notBefore.getDate() + CERT_VALIDITY_DAYS,
  );

  const subject = [{ name: "commonName", value: domain }];
  cert.setSubject(subject);
  cert.setIssuer(ca.caCert.subject.attributes);

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
    },
    {
      name: "subjectAltName",
      altNames: [{ type: 2, value: domain }], // DNS
    },
  ]);

  cert.sign(ca.caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Return cert + key PEM for the given domain, generating and caching them if
 * they don't exist yet in `certsDomainDir`.
 */
export function getDomainCert(
  domain: string,
  certsDomainDir: string,
  ca: CaAssets,
): DomainCert {
  if (!existsSync(certsDomainDir)) {
    mkdirSync(certsDomainDir, { recursive: true });
  }

  const certPath = join(certsDomainDir, `${domain}.cert.pem`);
  const keyPath = join(certsDomainDir, `${domain}.key.pem`);

  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      certPem: readFileSync(certPath, "utf-8"),
      keyPem: readFileSync(keyPath, "utf-8"),
    };
  }

  const generated = generateDomainCert(domain, ca);
  writeFileSync(certPath, generated.certPem, { mode: 0o600 });
  writeFileSync(keyPath, generated.keyPem, { mode: 0o600 });
  return generated;
}
