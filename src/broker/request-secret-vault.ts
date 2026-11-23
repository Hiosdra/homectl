import { randomUUID } from "node:crypto";
import type { VaultPort } from "../secrets/types";
import { HomectlError } from "../types";
import type { VaultSession } from "../vault";
import { GROUPS } from "../vault/groups";

const GROUP = `${GROUPS.secrets}/requests`;

export function requestSecretVault(
  session: Pick<
    VaultSession,
    "check" | "putSecret" | "getSecret" | "listEntries"
  >,
): VaultPort {
  return {
    async save(name, values) {
      if (!session.check()) throw new HomectlError(5, "The vault is locked");
      // A new value always has a new identity. A repeated display name cannot
      // change the entry behind an earlier approval's reference.
      const title = `${name} (${randomUUID()})`;
      return (await session.putSecret(title, values, { group: GROUP })).id;
    },
    async load(id) {
      if (!session.check()) return undefined;
      const record = session.listEntries().find((entry) => entry.id === id);
      if (record?.group !== GROUP || record.admin || record.kind !== "secret")
        return undefined;
      return session.getSecret(record.id);
    },
  };
}
