// Group layout inside the KDBX tree. Paths are relative to the top-level group
// that KeePassXC shows as the database root, so "homectl/ssh" means the "ssh"
// group under "homectl" under the root.
import type * as kdbx from "kdbxweb";

export const GROUPS = {
  ssh: "homectl/ssh",
  secrets: "homectl/secrets",
  api: "homectl/api",
} as const;

const GROUP_PATH = /^homectl(\/[a-z][a-z0-9-]{0,62}){0,3}$/;

export function validGroupPath(path: string): boolean {
  return GROUP_PATH.test(path);
}

// Returns the group at `path`, creating missing segments.
export function ensureGroup(db: kdbx.Kdbx, path: string): kdbx.KdbxGroup {
  let group = db.getDefaultGroup();
  for (const segment of path.split("/")) {
    let child = group.groups.find((g) => g.name === segment);
    if (!child) child = db.createGroup(group, segment);
    group = child;
  }
  return group;
}

// Ancestor names from the top-level group down to the entry, excluding the
// top-level group itself.
export function groupPath(entry: kdbx.KdbxEntry): string {
  const names: string[] = [];
  let group = entry.parentGroup;
  while (group?.parentGroup) {
    names.unshift(group.name ?? "");
    group = group.parentGroup;
  }
  return names.join("/");
}

export function inRecycleBin(db: kdbx.Kdbx, entry: kdbx.KdbxEntry): boolean {
  const recycleBin = db.meta.recycleBinUuid?.id;
  if (!recycleBin) return false;
  let group: kdbx.KdbxGroup | undefined = entry.parentGroup;
  while (group) {
    if (group.uuid.id === recycleBin) return true;
    group = group.parentGroup;
  }
  return false;
}
