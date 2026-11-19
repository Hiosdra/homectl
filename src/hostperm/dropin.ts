// Sudoers drop-ins owned by homectl (#21 C2). Only /etc/sudoers.d/homectl-<user>
// is ever written. The managed header lets revoke and drift checks recognise
// homectl's own files and refuse anything else.
import { sudoers } from "../policies";
import { HomectlError } from "../types";
import type { Grant, OsFamily, RemoteExec } from "./types";
import {
  assertAccountName,
  assertGrantId,
  lineDiff,
  rootGroup,
  sha256Hex,
  sudo,
} from "./util";

export const SUDOERS_DIR = "/etc/sudoers.d";

const HEADER_RE =
  /^# homectl-managed id=([a-z][a-z0-9-]{0,62}) sha256=([0-9a-f]{64})$/;

export type DriftState = "absent" | "match" | "modified" | "foreign";

// Names containing a dot are ignored by sudo's includedir, so temporary and
// backup files stay inert even if left behind.
export function dropInPath(user: string): string {
  assertAccountName(user);
  return `${SUDOERS_DIR}/homectl-${user}`;
}

export function dropInTempPath(user: string): string {
  assertAccountName(user);
  return `${SUDOERS_DIR}/.homectl-${user}.new`;
}

export function dropInBackupPath(user: string): string {
  assertAccountName(user);
  return `${SUDOERS_DIR}/.homectl-${user}.bak`;
}

export interface ManagedHeader {
  id: string;
  sha256: string;
  body: string;
}

// Returns undefined when the first line is not a homectl header (foreign file).
export function parseManaged(content: string): ManagedHeader | undefined {
  const newline = content.indexOf("\n");
  const first = newline < 0 ? content : content.slice(0, newline);
  const match = HEADER_RE.exec(first);
  if (!match) return undefined;
  return {
    id: match[1] ?? "",
    sha256: match[2] ?? "",
    body: newline < 0 ? "" : content.slice(newline + 1),
  };
}

// Header first, then the body. The header hash covers the body only.
export function managedContent(id: string, body: string): string {
  return `# homectl-managed id=${id} sha256=${sha256Hex(body)}\n${body}`;
}

// Literal-only rules come from policies.sudoers(); this function adds nothing
// to them, so both renderers accept and reject exactly the same inputs.
export function renderDropIn(user: string, grant: Grant, id: string): string {
  assertAccountName(user);
  assertGrantId(id);
  const body =
    grant.kind === "full"
      ? sudoers(user, {
          description: "homectl grant",
          transport: "ssh",
          access: "full",
        })
      : sudoers(user, {
          description: "homectl grant",
          transport: "ssh",
          access: "sudo-approved",
          sudo_allow: grant.argv,
        });
  return managedContent(id, body);
}

// Reads a root-owned file under sudo. Returns undefined only when the file is
// absent and sudo itself works; any other failure is an error, so an
// unavailable sudo is never mistaken for a missing file.
export async function readRemoteFile(
  exec: RemoteExec,
  path: string,
): Promise<string | undefined> {
  const read = await exec(sudo(["cat", path]));
  if (read.exitCode === 0) return read.stdout;
  const probe = await exec(sudo(["test", "-e", path]));
  if (probe.exitCode === 0)
    throw new HomectlError(5, `Could not read ${path} under sudo`);
  const sudoCheck = await exec(sudo(["true"]));
  if (sudoCheck.exitCode !== 0)
    throw new HomectlError(
      5,
      "sudo -n is unavailable; cannot read the sudoers state",
    );
  return undefined;
}

export interface DropInPlan {
  user: string;
  path: string;
  id: string;
  os: OsFamily;
  // Owner group for the installed file (root or wheel).
  group: string;
  current?: string;
  desired: string;
  diff: string;
  changed: boolean;
  foreign: boolean;
  // SHA-256 of the complete desired file, as sha256sum reports it.
  desiredSha256: string;
}

// Reads the live file and returns a preview. Nothing is written.
export async function planGrant(
  exec: RemoteExec,
  user: string,
  desired: string,
  options: { os?: OsFamily } = {},
): Promise<DropInPlan> {
  const path = dropInPath(user);
  const managed = parseManaged(desired);
  if (!managed)
    throw new HomectlError(
      2,
      "Desired drop-in must carry a homectl-managed header; build it with renderDropIn",
    );
  if (managed.sha256 !== sha256Hex(managed.body))
    throw new HomectlError(
      2,
      "Desired drop-in header hash does not match its body",
    );
  const os = options.os ?? "linux";
  if (os === "unknown")
    throw new HomectlError(3, "Drop-in grants need Linux, Darwin or FreeBSD");
  const current = await readRemoteFile(exec, path);
  return {
    user,
    path,
    id: managed.id,
    os,
    group: rootGroup(os),
    current,
    desired,
    diff: lineDiff(current ?? "", desired),
    changed: current !== desired,
    foreign: current !== undefined && parseManaged(current) === undefined,
    desiredSha256: sha256Hex(desired),
  };
}

// Compares the live file with homectl's own record (the body hash it recorded
// at apply time, when known). Does not write anything.
export async function detectDrift(
  exec: RemoteExec,
  user: string,
  recordedHash?: string,
): Promise<DriftState> {
  const content = await readRemoteFile(exec, dropInPath(user));
  if (content === undefined) return "absent";
  const managed = parseManaged(content);
  if (!managed) return "foreign";
  const actual = sha256Hex(managed.body);
  if (managed.sha256 !== actual) return "modified";
  if (recordedHash !== undefined && recordedHash !== actual) return "modified";
  return "match";
}
