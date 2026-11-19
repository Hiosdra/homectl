// Restore and server-side decryption (homelab #21 §6, D6A). The server can
// decrypt client backups because it holds the wrapped client keys under its
// custody key. That capability is never automatic: unwrapping a client key
// and restoring a snapshot both require an explicit owner authorization with
// a fresh step-up and a stated reason. Restores also refuse to return data
// unless the whole snapshot verifies.
import { HomectlError } from "../types";
import { unwrapKey } from "./keys";
import type { BackupStore } from "./store";
import type { RestoredFile } from "./verify";
import { inspectSnapshot } from "./verify";

export interface RestoreAuthorization {
  kind: "owner";
  stepUp: true;
  reason: string;
}

export function assertRestoreAuthorization(
  authorization: RestoreAuthorization | undefined,
): asserts authorization is RestoreAuthorization {
  const a = authorization as Partial<RestoreAuthorization> | undefined;
  if (
    !a ||
    a.kind !== "owner" ||
    a.stepUp !== true ||
    typeof a.reason !== "string" ||
    a.reason.trim().length === 0
  )
    throw new HomectlError(
      3,
      "Backup decryption needs an owner authorization with step-up and a reason",
    );
}

// The only path from the custody key to a client backup key.
export function unwrapCustodyKey(
  wrapped: string,
  custodyKey: Uint8Array,
  client: string,
  authorization: RestoreAuthorization | undefined,
): Uint8Array {
  assertRestoreAuthorization(authorization);
  return unwrapKey(wrapped, custodyKey, client);
}

export async function restoreSnapshot(
  store: BackupStore,
  client: string,
  seq: number,
  authorization: RestoreAuthorization | undefined,
  key: Uint8Array,
): Promise<RestoredFile[]> {
  assertRestoreAuthorization(authorization);
  const inspection = await inspectSnapshot(store, client, seq, key, true);
  if (!inspection.ok || !inspection.files)
    throw new HomectlError(
      5,
      `Snapshot ${seq} failed verification; refusing to restore: ${inspection.problems.join("; ")}`,
    );
  return inspection.files;
}
