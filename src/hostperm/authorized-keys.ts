// authorized_keys management without a shell (#21 C1/C2). Only lines tagged
// `homectl:<id>` are ever removed; every other line is preserved byte for byte.
import { HomectlError } from "../types";
import type { RemoteExec, StepReport } from "./types";
import { assertAccountName, firstToken, ID_RE, runStep, sudo } from "./util";

const KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+=*( [\x20-\x7e]*)?$/;
const HOME_RE = /^\/[A-Za-z0-9._/-]+$/;
const TAG_RE = /(?:^|\s)homectl:([a-z][a-z0-9-]{0,62})\s*$/;

export type KeyStatus =
  | "added"
  | "removed"
  | "unchanged"
  | "refused"
  | "failed"
  | "rolled-back"
  | "restore-failed";

export interface KeyReport {
  status: KeyStatus;
  path: string;
  steps: StepReport[];
  reason: string;
}

export interface KeyTarget {
  user: string;
  home: string;
  // Use sudo -n for reads and writes (needed for accounts other than the caller).
  useSudo: boolean;
}

export interface AddKeyOptions extends KeyTarget {
  id: string;
  publicKey: string;
}

export interface RemoveKeyOptions extends KeyTarget {
  id: string;
}

// Returns the homectl tag of a line, if it ends with one.
export function keyTag(line: string): string | undefined {
  return TAG_RE.exec(line)?.[1];
}

// The key type and base64 body: the part that identifies the key.
export function keyMaterial(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

// Rejects options prefixes, multiple lines and comments that could impersonate a tag.
export function validatePublicKey(key: string, id: string): void {
  if (!ID_RE.test(id)) throw new HomectlError(2, "Invalid grant id");
  if (!KEY_RE.test(key))
    throw new HomectlError(
      2,
      "Public key must be a single line: key type and base64 body, no options prefix",
    );
  if (key.includes("homectl:"))
    throw new HomectlError(2, "Public key comment must not contain 'homectl:'");
}

function targetFor(target: KeyTarget): { sshDir: string; path: string } {
  assertAccountName(target.user);
  const { home } = target;
  if (
    !HOME_RE.test(home) ||
    home.endsWith("/") ||
    home.split("/").includes("..")
  )
    throw new HomectlError(
      2,
      "Home must be an absolute path with safe characters",
    );
  return { sshDir: `${home}/.ssh`, path: `${home}/.ssh/authorized_keys` };
}

// Pure edit: appends `<key> homectl:<id>` unless that exact grant already exists.
export function editAddKey(
  current: string,
  key: string,
  id: string,
): { next: string; changed: boolean; note: string } {
  const material = keyMaterial(key);
  const lines = current.split("\n");
  if (
    lines.some((line) => keyTag(line) === id && keyMaterial(line) === material)
  )
    return {
      next: current,
      changed: false,
      note: "key already authorized for this homectl id",
    };
  if (lines.some((line) => keyMaterial(line) === material))
    return {
      next: current,
      changed: false,
      note: "key already present without a homectl tag; left unchanged",
    };
  const line = `${key} homectl:${id}`;
  const next =
    current === ""
      ? `${line}\n`
      : `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
  return { next, changed: true, note: "key added" };
}

// Pure edit: drops only lines tagged with this id; keeps everything else.
export function editRemoveKey(
  current: string,
  id: string,
): { next: string; changed: boolean; removed: number } {
  const parts = current.split("\n");
  const kept = parts.filter((line) => keyTag(line) !== id);
  const removed = parts.length - kept.length;
  return { next: kept.join("\n"), changed: removed > 0, removed };
}

export async function addAuthorizedKey(
  exec: RemoteExec,
  options: AddKeyOptions,
): Promise<KeyReport> {
  targetFor(options);
  validatePublicKey(options.publicKey, options.id);
  return editAuthorizedKeys(exec, options, (current) => {
    const edit = editAddKey(current, options.publicKey, options.id);
    return {
      next: edit.next,
      changed: edit.changed,
      note: edit.note,
      done: "added",
    };
  });
}

export async function removeAuthorizedKey(
  exec: RemoteExec,
  options: RemoveKeyOptions,
): Promise<KeyReport> {
  targetFor(options);
  if (!ID_RE.test(options.id)) throw new HomectlError(2, "Invalid grant id");
  return editAuthorizedKeys(exec, options, (current) => {
    const edit = editRemoveKey(current, options.id);
    return {
      next: edit.next,
      changed: edit.changed,
      note: edit.changed
        ? `removed ${edit.removed} homectl-tagged line(s)`
        : "no homectl-tagged line for this id",
      done: "removed",
    };
  });
}

interface Edit {
  next: string;
  changed: boolean;
  note: string;
  // Status reported when the edit is written and verified.
  done: "added" | "removed";
}

async function editAuthorizedKeys(
  exec: RemoteExec,
  options: KeyTarget,
  edit: (current: string) => Edit,
): Promise<KeyReport> {
  const { sshDir, path } = targetFor(options);
  const steps: StepReport[] = [];
  const priv = (argv: string[]): string[] =>
    options.useSudo ? sudo(argv) : argv;
  const report = (status: KeyStatus, reason: string): KeyReport => ({
    status,
    path,
    steps,
    reason,
  });

  // Symlinks are refused: on Proxmox clusters they usually point at shared storage.
  const dirLink = await runStep(
    exec,
    steps,
    "check-ssh-dir-link",
    priv(["test", "-L", sshDir]),
  );
  if (dirLink.ok)
    return report(
      "refused",
      "ssh directory is a symlink; review cluster-wide effect before editing",
    );
  const fileLink = await runStep(
    exec,
    steps,
    "check-authorized-keys-link",
    priv(["test", "-L", path]),
  );
  if (fileLink.ok)
    return report(
      "refused",
      "symlinked authorized_keys; review cluster-wide effect",
    );

  const exists = await runStep(
    exec,
    steps,
    "check-exists",
    priv(["test", "-e", path]),
  );
  let current = "";
  if (exists.ok) {
    const read = await runStep(exec, steps, "read", priv(["cat", path]));
    if (!read.ok) return report("failed", "could not read authorized_keys");
    current = read.stdout;
  }

  const planned = edit(current);
  if (!planned.changed) return report("unchanged", planned.note);

  const group = await runStep(exec, steps, "resolve-group", [
    "id",
    "-gn",
    options.user,
  ]);
  if (!group.ok)
    return report("failed", "could not resolve the account's primary group");
  const groupName = firstToken(group.stdout);

  // Writes content to a temp file beside authorized_keys, then renames it over.
  const write = async (content: string): Promise<boolean> => {
    const dir = await runStep(
      exec,
      steps,
      "check-ssh-dir",
      priv(["test", "-d", sshDir]),
    );
    if (!dir.ok) {
      const made = await runStep(
        exec,
        steps,
        "create-ssh-dir",
        priv([
          "install",
          "-d",
          "-m",
          "0700",
          "-o",
          options.user,
          "-g",
          groupName,
          sshDir,
        ]),
      );
      if (!made.ok) return false;
    }
    const tmp = `${sshDir}/.authorized_keys.homectl-new`;
    const staged = await runStep(
      exec,
      steps,
      "write-temp",
      priv([
        "install",
        "-m",
        "0600",
        "-o",
        options.user,
        "-g",
        groupName,
        "/dev/stdin",
        tmp,
      ]),
      content,
    );
    if (!staged.ok) return false;
    const swapped = await runStep(
      exec,
      steps,
      "swap",
      priv(["mv", "-f", tmp, path]),
    );
    if (!swapped.ok) {
      await runStep(exec, steps, "remove-temp", priv(["rm", "-f", tmp]));
      return false;
    }
    return true;
  };

  if (!(await write(planned.next)))
    return report(
      "failed",
      "could not write authorized_keys; previous content untouched",
    );

  const verify = await runStep(exec, steps, "verify", priv(["cat", path]));
  if (verify.ok && verify.stdout === planned.next)
    return report(planned.done, planned.note);

  // Restore the previous state after a failed verification.
  const restored = exists.ok
    ? await write(current)
    : (await runStep(exec, steps, "remove-new", priv(["rm", "-f", path]))).ok;
  return report(
    restored ? "rolled-back" : "restore-failed",
    restored
      ? "verification failed; previous authorized_keys restored"
      : `verification failed and restoring ${path} failed; review manually`,
  );
}
