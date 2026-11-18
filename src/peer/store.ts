import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { atomicReplace, privateDirectory, protect } from "../platform";
import { hash } from "./sync";
export type Permissions = {
  sync: boolean;
  diagnostics: boolean;
  operations: string[];
  administer: boolean;
};
export type Peer = {
  id: string;
  name: string;
  platform: string;
  address: string;
  key: string;
  permissions: Permissions;
  pairedAt: number;
  // Base64 SPKI of the peer's device signing key (ADR-0002).
  signingKey?: string;
};
// `at` is the wall-clock time of the last change, used to pick the later change by default.
export type Version = {
  clock: Record<string, number>;
  value: unknown | null;
  at?: number;
};
export type PeerState = {
  version: 1;
  id: string;
  name: string;
  key: string;
  peers: Record<string, Peer>;
  records: Record<string, Version>;
  observed: Record<string, string>;
};
export const defaults = (): Permissions => ({
  sync: true,
  diagnostics: false,
  operations: [],
  administer: false,
});
export function peerPath(inventory: string) {
  return join(dirname(inventory), "peers.json");
}
function savedCommandPeerPath(path: string) {
  return join(dirname(path), "peers-saved-commands.json");
}

// Saved-command sidecars that exist but could not be read or parsed. Saved-command
// sync stays disabled for them and their file is never overwritten until it is repaired.
const unreadableSavedCommandSidecars = new Set<string>();
async function writeStateFile(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await protect(tmp);
  await atomicReplace(tmp, path);
}
export async function saveState(path: string, state: PeerState) {
  await privateDirectory(dirname(path));
  const records = Object.entries(state.records);
  const observed = Object.entries(state.observed ?? {});
  const savedRecords = Object.fromEntries(
    records.filter(([id]) => id.startsWith("saved-command:")),
  );
  const savedObserved = Object.fromEntries(
    observed.filter(([id]) => id.startsWith("saved-command:")),
  );
  const ordinaryRecords = Object.fromEntries(
    records.filter(([id]) => !id.startsWith("saved-command:")),
  );
  const ordinaryObserved = Object.fromEntries(
    observed.filter(([id]) => !id.startsWith("saved-command:")),
  );
  const disk = {
    ...state,
    observed: ordinaryObserved,
    records: Object.fromEntries(
      Object.entries(ordinaryRecords).map(([id, r]) => [
        id,
        id.startsWith("credential:") && r.value !== null
          ? {
              ...r,
              value:
                typeof r.value === "object" && "fingerprint" in r.value
                  ? r.value
                  : { fingerprint: hash(r.value) },
            }
          : r,
      ]),
    ),
  };
  if (!unreadableSavedCommandSidecars.has(savedCommandPeerPath(path)))
    await writeStateFile(savedCommandPeerPath(path), {
      version: 1,
      records: savedRecords,
      observed: savedObserved,
    });
  await writeStateFile(path, disk);
}
export async function loadState(path: string): Promise<PeerState> {
  let state: PeerState;
  let missing = false;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as PeerState;
    if (
      state.version !== 1 ||
      !state.id ||
      !state.key ||
      !state.peers ||
      !state.records
    )
      throw new Error();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    missing = true;
    state = {
      version: 1,
      id: randomUUID(),
      name: hostname(),
      key: randomBytes(32).toString("hex"),
      peers: {},
      records: {},
      observed: {},
    };
  }
  const legacyRecords = Object.fromEntries(
    Object.entries(state.records).filter(([id]) =>
      id.startsWith("saved-command:"),
    ),
  );
  const legacyObserved = Object.fromEntries(
    Object.entries(state.observed ?? {}).filter(([id]) =>
      id.startsWith("saved-command:"),
    ),
  );
  const ordinaryRecords = Object.fromEntries(
    Object.entries(state.records).filter(
      ([id]) => !id.startsWith("saved-command:"),
    ),
  );
  const ordinaryObserved = Object.fromEntries(
    Object.entries(state.observed ?? {}).filter(
      ([id]) => !id.startsWith("saved-command:"),
    ),
  );
  let savedState: {
    records: Record<string, Version>;
    observed: Record<string, string>;
  } = { records: {}, observed: {} };
  const sidecar = savedCommandPeerPath(path);
  try {
    const parsed = JSON.parse(await readFile(sidecar, "utf8")) as {
      version?: unknown;
      records?: Record<string, Version>;
      observed?: Record<string, string>;
    };
    if (
      parsed.version !== 1 ||
      !parsed.records ||
      typeof parsed.records !== "object" ||
      !parsed.observed ||
      typeof parsed.observed !== "object"
    )
      throw new Error("Saved-command peer state is corrupt");
    savedState = {
      records: Object.fromEntries(
        Object.entries(parsed.records).filter(([id]) =>
          id.startsWith("saved-command:"),
        ),
      ),
      observed: Object.fromEntries(
        Object.entries(parsed.observed).filter(([id]) =>
          id.startsWith("saved-command:"),
        ),
      ),
    };
    unreadableSavedCommandSidecars.delete(sidecar);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      unreadableSavedCommandSidecars.delete(sidecar);
    } else {
      // Degrade instead of failing Hub.init: ordinary peer sync keeps working.
      unreadableSavedCommandSidecars.add(sidecar);
      savedState = { records: {}, observed: {} };
      console.warn(
        "Saved-command peer sync state could not be read; saved-command sync is disabled and the file was left unchanged.",
      );
    }
  }
  state = {
    ...state,
    records: { ...ordinaryRecords, ...legacyRecords, ...savedState.records },
    observed: {
      ...ordinaryObserved,
      ...legacyObserved,
      ...savedState.observed,
    },
  };
  if (
    missing ||
    Object.keys(legacyRecords).length ||
    Object.keys(legacyObserved).length
  )
    await saveState(path, state);
  return state;
}
