import { randomUUID } from "node:crypto";
import { normalizeDestination } from "../secrets/destinations";
import {
  FIELD_NAME_PATTERN,
  type SavedSecretGrant,
  type VaultPort,
} from "../secrets/types";
import { isRecord } from "../secrets/validation";
import { HomectlError } from "../types";
import type { EntryMeta, VaultSession } from "../vault";
import { GROUPS } from "../vault/groups";

const GROUP = `${GROUPS.secrets}/requests`;
const SCOPE = "Reuse scope";

function reuseTags(binding: string): string[] {
  return [`scope-a-${binding.slice(0, 32)}`, `scope-b-${binding.slice(32)}`];
}

function isScopeTag(tag: string): boolean {
  return /^scope-[ab]-[a-f0-9]{32}$/.test(tag);
}

function grantOf(
  entry: EntryMeta,
  scope: string,
): SavedSecretGrant | undefined {
  try {
    const data: unknown = JSON.parse(scope);
    if (!isRecord(data) || typeof data.client !== "string") return undefined;
    return {
      id: entry.id,
      name: entry.name.split(" (")[0] ?? entry.name,
      client: data.client,
      fields: Array.isArray(data.fields)
        ? data.fields.filter(
            (field): field is string =>
              typeof field === "string" && FIELD_NAME_PATTERN.test(field),
          )
        : [],
      ...(typeof data.task === "string" ? { task: data.task } : {}),
      destination: normalizeDestination(data.destination, () => true),
    };
  } catch {
    return undefined;
  }
}

export function requestSecretVault(
  session: Pick<
    VaultSession,
    "check" | "putSecret" | "getSecret" | "getField" | "listEntries" | "setTags"
  >,
): VaultPort {
  function owned(): EntryMeta[] {
    if (!session.check()) return [];
    return session
      .listEntries()
      .filter(
        (entry) =>
          entry.group === GROUP && !entry.admin && entry.kind === "secret",
      );
  }

  function grant(entry: EntryMeta): SavedSecretGrant | undefined {
    const scope = session.getField(entry.id, SCOPE);
    return scope === undefined ? undefined : grantOf(entry, scope);
  }

  return {
    async save(name, values, meta) {
      if (!session.check()) throw new HomectlError(5, "The vault is locked");
      // A repeated display name never replaces a value behind an earlier grant.
      const title = `${name} (${randomUUID()})`;
      if (!meta.reuseBinding)
        return (await session.putSecret(title, values, { group: GROUP })).id;
      const scope = JSON.stringify({
        client: meta.client,
        fields: meta.fields,
        task: meta.task,
        destination: meta.destination,
      });
      if (scope.length > 16_384)
        throw new HomectlError(
          2,
          "The destination is too large for a reusable grant",
        );
      return (
        await session.putSecret(
          title,
          { ...values, [SCOPE]: scope },
          {
            group: GROUP,
            tags: reuseTags(meta.reuseBinding),
          },
        )
      ).id;
    },
    async load(id) {
      if (!owned().some((entry) => entry.id === id)) return undefined;
      return Object.fromEntries(
        Object.entries(session.getSecret(id)).filter(([field]) =>
          FIELD_NAME_PATTERN.test(field),
        ),
      );
    },
    findReuse(binding) {
      const tags = reuseTags(binding);
      const matches = owned().filter((entry) =>
        tags.every((tag) => entry.tags.includes(tag)),
      );
      const [entry] = matches;
      return matches.length === 1 && entry && grant(entry)
        ? entry.id
        : undefined;
    },
    listReuse() {
      return owned()
        .filter((entry) => entry.tags.filter(isScopeTag).length === 2)
        .flatMap((entry) => grant(entry) ?? []);
    },
    async revokeReuse(id) {
      const entry = owned().find((candidate) => candidate.id === id);
      if (!entry) throw new HomectlError(3, "Saved secret not found");
      await session.setTags(
        id,
        entry.tags.filter((tag) => !isScopeTag(tag)),
      );
    },
  };
}
