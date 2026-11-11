import { HomectlError } from "../types";
import type { Permissions, Version } from "./store";
import { hash } from "./sync";

// Checks for the peer protocol's permission grants, and the record views the panel gets.
export function validatePermissions(p: Permissions) {
  if (
    !p ||
    typeof p.sync !== "boolean" ||
    typeof p.diagnostics !== "boolean" ||
    typeof p.administer !== "boolean" ||
    !Array.isArray(p.operations) ||
    p.operations.length > 256 ||
    p.operations.some((h) => !/^[a-z][a-z0-9-]{0,62}$/.test(h))
  )
    throw new HomectlError(2, "Invalid peer permissions");
}

export function safeVersion(id: string, v: Version) {
  return id.startsWith("credential:")
    ? {
        clock: v.clock,
        value:
          v.value === null
            ? null
            : { secret: true, fingerprint: hash(v.value) },
      }
    : v;
}
