// Filesystem backup store (homelab #21 §6). Layout under the store root:
//   chunks/<first two hex chars>/<chunk id>     sealed chunk blobs
//   manifests/<client>/<seq, 10 digits>.json.enc  stored manifests
//   store.lock                                     commit/prune serialization
// Every directory is private to this user; every write is temp + rename.
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensurePrivateDirectoryOnce } from "../control/file-lock";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { BLOB_VERSION } from "./keys";
import type { StoredManifest } from "./types";
import { assertChunkId, assertClient, parseStored } from "./types";

const CHUNK_DIRECTORY = "chunks";
const MANIFEST_DIRECTORY = "manifests";
const CHUNK_FILE = /^[0-9a-f]{64}$/;
const MANIFEST_FILE = /^(\d{10})\.json\.enc$/;
// A sealed blob is at least a version byte, an IV and a tag.
const MIN_BLOB_BYTES = 1 + 12 + 16;

// Counts removals per store root, across every store object on that root. A
// cache of what a store holds (the workspace quota ledger) compares it to know
// that a prune or sweep has changed the contents since the cache was built.
const removals = new Map<string, number>();

export function storeRevision(root: string): number {
  return removals.get(resolve(root)) ?? 0;
}

function noteRemoval(root: string): void {
  const key = resolve(root);
  removals.set(key, (removals.get(key) ?? 0) + 1);
}

export function manifestFileName(seq: number): string {
  return `${String(seq).padStart(10, "0")}.json.enc`;
}

export async function writeAtomic(path: string, data: Uint8Array) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await atomicReplace(temp, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export class BackupStore {
  readonly chunks: ChunkStore;
  readonly manifests: ManifestStore;
  private ready: Promise<void> | undefined;

  constructor(readonly root: string) {
    this.chunks = new ChunkStore(this);
    this.manifests = new ManifestStore(this);
  }

  // Creates the private root once. Children inherit its protection.
  ensureRoot(): Promise<void> {
    this.ready ??= ensurePrivateDirectoryOnce(this.root).catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  lockPath(): string {
    return join(this.root, "store.lock");
  }
}

export class ChunkStore {
  constructor(private readonly store: BackupStore) {}

  private directory(id: string): string {
    return join(this.store.root, CHUNK_DIRECTORY, id.slice(0, 2));
  }

  private file(id: string): string {
    return join(this.directory(id), id);
  }

  async has(id: string): Promise<boolean> {
    assertChunkId(id);
    return exists(this.file(id));
  }

  // Idempotent: returns false when the blob was already present.
  async put(id: string, blob: Uint8Array): Promise<boolean> {
    assertChunkId(id);
    if (blob.length < MIN_BLOB_BYTES || blob[0] !== BLOB_VERSION)
      throw new HomectlError(2, "Chunk blob is not a sealed backup blob");
    await this.store.ensureRoot();
    if (await this.has(id)) return false;
    await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
    await writeAtomic(this.file(id), blob);
    return true;
  }

  async get(id: string): Promise<Uint8Array> {
    assertChunkId(id);
    try {
      return new Uint8Array(await readFile(this.file(id)));
    } catch {
      throw new HomectlError(5, `Chunk ${id.slice(0, 12)} is missing`);
    }
  }

  async stat(id: string): Promise<{ size: number; mtimeMs: number }> {
    assertChunkId(id);
    const info = await stat(this.file(id));
    return { size: info.size, mtimeMs: info.mtimeMs };
  }

  async list(): Promise<string[]> {
    const ids: string[] = [];
    const root = join(this.store.root, CHUNK_DIRECTORY);
    for (const prefix of await listDirectory(root)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of await listDirectory(join(root, prefix)))
        if (CHUNK_FILE.test(name) && name.startsWith(prefix)) ids.push(name);
    }
    return ids.sort();
  }

  // Returns the number of bytes freed (0 when the chunk was already gone).
  async remove(id: string): Promise<number> {
    assertChunkId(id);
    let size = 0;
    try {
      size = (await stat(this.file(id))).size;
      await unlink(this.file(id));
    } catch {
      return 0;
    }
    noteRemoval(this.store.root);
    return size;
  }
}

export class ManifestStore {
  constructor(private readonly store: BackupStore) {}

  private directory(client: string): string {
    assertClient(client);
    return join(this.store.root, MANIFEST_DIRECTORY, client);
  }

  private file(client: string, seq: number): string {
    return join(this.directory(client), manifestFileName(seq));
  }

  async read(client: string, seq: number): Promise<StoredManifest | undefined> {
    const path = this.file(client, seq);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    return this.parse(client, seq, text);
  }

  // Ascending by seq. A corrupt entry throws: callers must not guess at it.
  async list(client: string): Promise<StoredManifest[]> {
    const entries: { seq: number; name: string }[] = [];
    for (const name of await listDirectory(this.directory(client))) {
      const match = MANIFEST_FILE.exec(name);
      if (match) entries.push({ seq: Number(match[1]), name });
    }
    entries.sort((a, b) => a.seq - b.seq);
    const out: StoredManifest[] = [];
    for (const entry of entries) {
      const text = await readFile(
        join(this.directory(client), entry.name),
        "utf8",
      );
      out.push(this.parse(client, entry.seq, text));
    }
    return out;
  }

  async write(client: string, stored: StoredManifest): Promise<void> {
    await this.store.ensureRoot();
    const directory = this.directory(client);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    await writeAtomic(
      this.file(client, stored.header.seq),
      new TextEncoder().encode(text),
    );
  }

  // Returns the removed file size in bytes (0 if absent).
  async remove(client: string, seq: number): Promise<number> {
    const path = this.file(client, seq);
    try {
      const size = (await stat(path)).size;
      await unlink(path);
      noteRemoval(this.store.root);
      return size;
    } catch {
      return 0;
    }
  }

  private parse(client: string, seq: number, text: string): StoredManifest {
    let stored: StoredManifest;
    try {
      stored = parseStored(JSON.parse(text));
    } catch {
      throw new HomectlError(5, `Stored manifest ${client} #${seq} is corrupt`);
    }
    if (stored.header.client !== client || stored.header.seq !== seq)
      throw new HomectlError(
        5,
        `Stored manifest ${client} #${seq} does not match its file name`,
      );
    return stored;
  }
}

export async function clientsWithManifests(
  store: BackupStore,
): Promise<string[]> {
  const root = join(store.root, MANIFEST_DIRECTORY);
  const names = await listDirectory(root);
  const clients: string[] = [];
  for (const name of names) {
    try {
      assertClient(name);
      clients.push(name);
    } catch {
      // Not a client directory; ignore it.
    }
  }
  return clients.sort();
}
