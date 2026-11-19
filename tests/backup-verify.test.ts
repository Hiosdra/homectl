import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RestoreAuthorization } from "../src/backup";
import {
  buildSnapshot,
  newClientKey,
  restoreSnapshot,
  unwrapCustodyKey,
  uploadSnapshot,
  verifySnapshot,
  wrapKey,
} from "../src/backup";
import type { Fixture } from "./backup-helpers";
import { CLIENT, codeOf, fileOf, fixture, SMALL_CHUNK } from "./backup-helpers";

const key = newClientKey();
const ownerAuth: RestoreAuthorization = {
  kind: "owner",
  stepUp: true,
  reason: "restore after laptop reset",
};

let current: Fixture | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

async function committed(files: { path: string; data: Uint8Array }[]) {
  current = await fixture();
  const snapshot = buildSnapshot(files, {
    client: CLIENT,
    key,
    seq: 1,
    parent: null,
    now: 1_700_000_000_000,
    chunkSize: SMALL_CHUNK,
  });
  await uploadSnapshot(current.server, snapshot);
  return { ...current, snapshot };
}

function chunkPath(store: Fixture["store"], id: string): string {
  return join(store.root, "chunks", id.slice(0, 2), id);
}

describe("backup verification and restore", () => {
  test("a freshly committed snapshot verifies", async () => {
    const { store } = await committed([
      fileOf("state/a.db", 40, 1),
      fileOf("state/b.db", 9, 2),
    ]);
    expect(await verifySnapshot(store, CLIENT, 1, key)).toEqual({
      ok: true,
      problems: [],
    });
  });

  test("a tampered chunk is detected by verify", async () => {
    const { store, snapshot } = await committed([fileOf("state/a.db", 40, 3)]);
    const id = snapshot.header.chunks[0] ?? "";
    const path = chunkPath(store, id);
    const blob = new Uint8Array(await readFile(path));
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0x01;
    await writeFile(path, blob);

    const result = await verifySnapshot(store, CLIENT, 1, key);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/fails authentication/);
  });

  test("a chunk moved under another id is detected", async () => {
    const { store, snapshot } = await committed([
      fileOf("state/a.db", 16, 4),
      fileOf("state/b.db", 16, 5),
    ]);
    const [first, second] = snapshot.header.chunks;
    if (!first || !second) throw new Error("expected two chunks");
    const blob = await readFile(chunkPath(store, first));
    await writeFile(chunkPath(store, second), blob);

    const result = await verifySnapshot(store, CLIENT, 1, key);
    expect(result.ok).toBe(false);
  });

  test("verify with the wrong key fails", async () => {
    const { store } = await committed([fileOf("state/a.db", 40, 6)]);
    const result = await verifySnapshot(store, CLIENT, 1, newClientKey());
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/cannot be decrypted/);
  });

  test("restore without owner authorization is refused with code 3", async () => {
    const { store } = await committed([fileOf("state/a.db", 40, 7)]);
    const refused: unknown[] = [
      undefined,
      { kind: "owner", stepUp: false, reason: "x" },
      { kind: "owner", stepUp: true, reason: "   " },
      { kind: "agent", stepUp: true, reason: "x" },
    ];
    for (const authorization of refused)
      expect(
        await codeOf(() =>
          restoreSnapshot(
            store,
            CLIENT,
            1,
            authorization as RestoreAuthorization | undefined,
            key,
          ),
        ),
      ).toBe(3);
  });

  test("restore with owner authorization returns the original bytes", async () => {
    const files = [fileOf("state/a.db", 40, 8), fileOf("state/empty.db", 0, 9)];
    const { store } = await committed(files);
    const restored = await restoreSnapshot(store, CLIENT, 1, ownerAuth, key);
    expect(restored.map((file) => file.path)).toEqual([
      "state/a.db",
      "state/empty.db",
    ]);
    for (const file of files) {
      const found = restored.find((item) => item.path === file.path);
      expect(
        Buffer.from(found?.data ?? new Uint8Array()).equals(
          Buffer.from(file.data),
        ),
      ).toBe(true);
    }
  });

  test("restore refuses a snapshot that fails verification", async () => {
    const { store, snapshot } = await committed([fileOf("state/a.db", 40, 10)]);
    const id = snapshot.header.chunks[0] ?? "";
    const path = chunkPath(store, id);
    const blob = new Uint8Array(await readFile(path));
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0x01;
    await writeFile(path, blob);

    expect(
      await codeOf(() => restoreSnapshot(store, CLIENT, 1, ownerAuth, key)),
    ).toBe(5);
  });

  test("the custody key unwraps a client key only with owner authorization", async () => {
    current = await fixture();
    const custody = newClientKey();
    const wrapped = wrapKey(key, custody, CLIENT);
    expect(
      await codeOf(() => unwrapCustodyKey(wrapped, custody, CLIENT, undefined)),
    ).toBe(3);
    const unwrapped = unwrapCustodyKey(wrapped, custody, CLIENT, ownerAuth);
    expect(Buffer.from(unwrapped).equals(Buffer.from(key))).toBe(true);
    expect(() =>
      unwrapCustodyKey(wrapped, custody, "other-client", ownerAuth),
    ).toThrow();
  });
});
