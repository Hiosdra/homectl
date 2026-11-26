// Credential sources for opening databases. The master password is handed over
// as bytes; the JS string the owner typed cannot be cleared, so clearing here is
// best effort. `os-keychain` is part of the interface for later and is not
// implemented: nothing constructs it yet.
import * as kdbx from "kdbxweb";
import { HomectlError } from "../types";

export type CredentialKind = "password" | "os-keychain" | "keyfile";

export interface CredentialSource {
  readonly kind: CredentialKind;
  // Returns a fresh copy that the caller owns and should clear after use.
  get(): Promise<Uint8Array>;
}

export function passwordSource(password: string): CredentialSource {
  const bytes = new TextEncoder().encode(password);
  return {
    kind: "password",
    async get() {
      return bytes.slice();
    },
  };
}

// Builds kdbxweb credentials from a source. A keyfile source is used as the raw
// key file; any other source is a password.
export async function kdbxCredentials(
  source: CredentialSource,
): Promise<kdbx.KdbxCredentials> {
  let bytes: Uint8Array;
  try {
    bytes = await source.get();
  } catch {
    throw new HomectlError(5, "Vault credential unavailable");
  }
  try {
    // Copy with Uint8Array.from: Buffer.slice would share memory, not copy it.
    const copy = Uint8Array.from(bytes);
    const credentials =
      source.kind === "keyfile"
        ? new kdbx.Credentials(null, copy)
        : new kdbx.Credentials(kdbx.ProtectedValue.fromBinary(copy.buffer));
    return await credentials.ready;
  } finally {
    bytes.fill(0);
  }
}
