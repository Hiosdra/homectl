import { HomectlError } from "../types";

// OpenSSH may append the private key's comment when deriving its public key.
// Compare identities using the algorithm and blob, not that optional label.
export function normalizePublicKey(value: string): string {
  if (value.includes("\0"))
    throw new HomectlError(5, "Invalid public key generated");
  const match =
    /^ssh-ed25519[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+[^\r\n]*)?$/.exec(
      value.trim(),
    );
  if (!match?.[1]) throw new HomectlError(5, "Invalid public key generated");
  const blob = Buffer.from(match[1], "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32 ||
    blob.toString("base64").replace(/=+$/, "") !== match[1].replace(/=+$/, "")
  )
    throw new HomectlError(5, "Invalid public key generated");
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
