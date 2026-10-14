import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { privateDirectory, protect } from "../platform";
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
};
export type Version = { clock: Record<string, number>; value: unknown | null };
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
export async function saveState(path: string, state: PeerState) {
  await privateDirectory(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  const disk = {
    ...state,
    records: Object.fromEntries(
      Object.entries(state.records).map(([id, r]) => [
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
  await writeFile(tmp, JSON.stringify(disk), { mode: 0o600, flag: "wx" });
  await protect(tmp);
  await rename(tmp, path);
}
export async function loadState(path: string): Promise<PeerState> {
  try {
    const s = JSON.parse(await readFile(path, "utf8")) as PeerState;
    if (s.version !== 1 || !s.id || !s.key || !s.peers || !s.records)
      throw new Error();
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const s: PeerState = {
      version: 1,
      id: randomUUID(),
      name: hostname(),
      key: randomBytes(32).toString("hex"),
      peers: {},
      records: {},
      observed: {},
    };
    await saveState(path, s);
    return s;
  }
}
