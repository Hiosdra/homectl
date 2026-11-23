import { readFile } from "node:fs/promises";
import { keyReference } from "../session/keys";
import { normalizePublicKey } from "../session/public-key";
import { keyFingerprint } from "./host-keys";

// The public half of a managed key, for owner-only installation.
export async function readMachineKey(inventoryPath: string, name: string) {
  const auth = keyReference(name, inventoryPath);
  try {
    const publicKey = normalizePublicKey(
      await readFile(auth.public_key, "utf8"),
    );
    return {
      name,
      present: true,
      publicKey,
      fingerprint: keyFingerprint(publicKey.split(" ")[1] ?? ""),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { name, present: false };
    return {
      name,
      present: false,
      reason:
        "The key file is there but is not a public key homectl can use. Make the key again with a new name in your private terminal.",
    };
  }
}
