import forge from "node-forge";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CaAssets {
  caCert: forge.pki.Certificate;
  caKey: forge.pki.rsa.PrivateKey;
  caCertPem: string;
  caKeyPem: string;
}

const CA_VALIDITY_YEARS = 10;
const CERT_VALIDITY_DAYS = 825; // Apple cap for leaf certs

/** Generate a new CA keypair and self-signed certificate. */
function generateCa(): CaAssets {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(20));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS,
  );

  const attrs = [
    { name: "commonName", value: "proxy-rules Local CA" },
    { name: "organizationName", value: "proxy-rules" },
    { shortName: "OU", value: "Local Development" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    caCert: cert,
    caKey: keys.privateKey,
    caCertPem: forge.pki.certificateToPem(cert),
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Ensure a CA exists at the given paths; create one if missing. Returns CaAssets. */
export function ensureCa(caCertPath: string, caKeyPath: string): CaAssets & { created: boolean } {
  const certsDir = join(caCertPath, "..");
  if (!existsSync(certsDir)) {
    mkdirSync(certsDir, { recursive: true });
  }

  if (existsSync(caCertPath) && existsSync(caKeyPath)) {
    const caCertPem = readFileSync(caCertPath, "utf-8");
    const caKeyPem = readFileSync(caKeyPath, "utf-8");
    return {
      caCert: forge.pki.certificateFromPem(caCertPem),
      caKey: forge.pki.privateKeyFromPem(caKeyPem) as forge.pki.rsa.PrivateKey,
      caCertPem,
      caKeyPem,
      created: false,
    };
  }

  const assets = generateCa();
  writeFileSync(caCertPath, assets.caCertPem, { mode: 0o600 });
  writeFileSync(caKeyPath, assets.caKeyPem, { mode: 0o600 });
  return { ...assets, created: true };
}
