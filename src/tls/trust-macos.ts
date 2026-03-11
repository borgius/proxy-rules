import { spawnSync } from "node:child_process";
import picocolors from "picocolors";

export interface TrustResult {
  success: boolean;
  /** Human-readable message about what happened or what to do manually. */
  message: string;
}

/**
 * Attempt to install `caCertPath` into the macOS System keychain and mark it
 * as always-trusted for SSL. Requires `sudo` (or existing root permissions).
 *
 * Returns a TrustResult. On failure the message contains precise manual steps.
 */
export function tryInstallMacosTrust(caCertPath: string): TrustResult {
  // Try without sudo first (works if already running as root)
  const result = spawnSync(
    "security",
    [
      "add-trusted-cert",
      "-d",              // add to Admin cert store
      "-r", "trustRoot", // mark as root trust
      "-k", "/Library/Keychains/System.keychain",
      caCertPath,
    ],
    { encoding: "utf-8" },
  );

  if (result.status === 0) {
    return {
      success: true,
      message: "CA certificate installed and trusted in the macOS System keychain.",
    };
  }

  const manualSteps = `
${picocolors.bold("Automatic trust installation failed.")}
${picocolors.dim("Exit code:")} ${result.status ?? "n/a"}
${result.stderr ? picocolors.dim(result.stderr.trim()) : ""}

${picocolors.bold("To trust the proxy CA manually on macOS:")}

1. Run the following command as an administrator:

   ${picocolors.cyan(`sudo security add-trusted-cert -d -r trustRoot \\
     -k /Library/Keychains/System.keychain \\
     "${caCertPath}"`)}

   OR open Keychain Access → System → drag-and-drop the cert file:
   ${picocolors.cyan(caCertPath)}
   then double-click the cert → Expand "Trust" → set
   "Secure Sockets Layer (SSL)" to ${picocolors.bold("Always Trust")}.

2. Restart your browser after trusting the certificate.

3. Verify trust with:

   ${picocolors.cyan(`security verify-cert -c "${caCertPath}"`)}

${picocolors.bold("For iOS / iPadOS:")}
  Transfer ${picocolors.cyan(caCertPath)} to the device, install the profile,
  then go to Settings → General → About → Certificate Trust Settings
  and enable full trust for the proxy CA.

${picocolors.bold("For Firefox:")}
  Firefox uses its own certificate store.
  Go to Preferences → Privacy & Security → Certificates → View Certificates
  → Authorities tab → Import → select ${picocolors.cyan(caCertPath)}
  → check "Trust this CA to identify websites".
`.trim();

  return { success: false, message: manualSteps };
}
