import { afterEach, describe, expect, test } from "bun:test";
import type {
  BackupServer,
  CommitRequest,
  CommitResult,
  Snapshot,
} from "../src/backup";
import {
  backup,
  buildSnapshot,
  newClientKey,
  uploadSnapshot,
} from "../src/backup";
import type { Fixture } from "./backup-helpers";
import {
  bytesOf,
  CLIENT,
  codeOf,
  fileOf,
  fixture,
  SMALL_CHUNK,
} from "./backup-helpers";

const key = newClientKey();
const ctxOf = (
  seq: number,
  parent: string | null,
  now = 1_700_000_000_000,
) => ({
  client: CLIENT,
  key,
  seq,
  parent,
  now,
  chunkSize: SMALL_CHUNK,
});

// Fails putChunk after `allow` successful writes, like a dropped connection.
class FlakyServer implements BackupServer {
  private puts = 0;
  constructor(
    private readonly inner: BackupServer,
    private readonly allow: number,
  ) {}
  missing(ids: readonly string[]) {
    return this.inner.missing(ids);
  }
  async putChunk(id: string, blob: Uint8Array) {
    if (this.puts >= this.allow) throw new Error("connection reset");
    this.puts += 1;
    await this.inner.putChunk(id, blob);
  }
  commit(request: CommitRequest): Promise<CommitResult> {
    return this.inner.commit(request);
  }
}

let current: Fixture | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});
async function setup(): Promise<Fixture> {
  current = await fixture();
  return current;
}

describe("backup upload protocol", () => {
  test("a second snapshot with one changed file uploads only the changed chunks", async () => {
    const { server } = await setup();
    const first = buildSnapshot(
      [fileOf("state/a.db", 64, 1), fileOf("state/b.db", 64, 2)],
      ctxOf(1, null),
    );
    const sentFirst = await uploadSnapshot(server, first);
    expect(sentFirst.result.status).toBe("committed");
    expect(sentFirst.uploaded).toBe(first.chunks.size);

    // One byte changes in the last chunk of a.db; everything else is identical.
    const changed = bytesOf(64, 1);
    changed[63] = (changed[63] ?? 0) ^ 0xff;
    const second = buildSnapshot(
      [{ path: "state/a.db", data: changed }, fileOf("state/b.db", 64, 2)],
      ctxOf(2, first.header.manifestHash),
    );
    const sentSecond = await uploadSnapshot(server, second);
    expect(sentSecond.result.status).toBe("committed");
    expect(sentSecond.uploaded).toBe(1);
    expect(sentSecond.reused).toBe(7);
  });

  test("an interrupted upload resumes by sending only the missing chunks", async () => {
    const { server } = await setup();
    const snapshot = buildSnapshot(
      [fileOf("state/a.db", 96, 3)],
      ctxOf(1, null),
    );
    const total = snapshot.chunks.size;
    expect(total).toBe(6);

    await expect(
      uploadSnapshot(new FlakyServer(server, 2), snapshot),
    ).rejects.toThrow("connection reset");
    expect((await server.missing([...snapshot.chunks.keys()])).length).toBe(4);

    const resumed = await uploadSnapshot(server, snapshot);
    expect(resumed.result.status).toBe("committed");
    expect(resumed.uploaded).toBe(4);
    expect(resumed.reused).toBe(2);
  });

  test("commit rejects a manifest whose chunks were not uploaded", async () => {
    const { server } = await setup();
    const snapshot = buildSnapshot(
      [fileOf("state/a.db", 32, 4)],
      ctxOf(1, null),
    );
    expect(
      await codeOf(() =>
        server.commit({ header: snapshot.header, sealed: snapshot.sealed }),
      ),
    ).toBe(2);
  });

  test("commit is idempotent for the same manifest", async () => {
    const { server } = await setup();
    const snapshot = buildSnapshot(
      [fileOf("state/a.db", 32, 5)],
      ctxOf(1, null),
    );
    await uploadSnapshot(server, snapshot);
    const again = await server.commit({
      header: snapshot.header,
      sealed: snapshot.sealed,
    });
    expect(again).toEqual({ status: "unchanged", seq: 1 });
  });

  test("commit rejects a different manifest at an existing seq", async () => {
    const { server } = await setup();
    const original = buildSnapshot(
      [fileOf("state/a.db", 32, 6)],
      ctxOf(1, null),
    );
    await uploadSnapshot(server, original);
    const conflicting: Snapshot = buildSnapshot(
      [fileOf("state/a.db", 32, 7)],
      ctxOf(1, null),
    );
    const sent = uploadSnapshot(server, conflicting);
    await expect(sent).rejects.toThrow(/Conflicting manifest at seq 1/);
  });

  test("commit rejects a known but non-latest parent (fork)", async () => {
    const { server } = await setup();
    const s1 = buildSnapshot([fileOf("state/a.db", 32, 8)], ctxOf(1, null));
    await uploadSnapshot(server, s1);
    const s2 = buildSnapshot(
      [fileOf("state/a.db", 32, 9)],
      ctxOf(2, s1.header.manifestHash),
    );
    await uploadSnapshot(server, s2);
    const fork = buildSnapshot(
      [fileOf("state/a.db", 32, 10)],
      ctxOf(3, s1.header.manifestHash),
    );
    await expect(uploadSnapshot(server, fork)).rejects.toThrow(/Bad parent/);
  });

  test("commit rejects a seq that does not follow the latest one", async () => {
    const { server } = await setup();
    const s1 = buildSnapshot([fileOf("state/a.db", 32, 11)], ctxOf(1, null));
    await uploadSnapshot(server, s1);
    const skipped = buildSnapshot(
      [fileOf("state/a.db", 32, 12)],
      ctxOf(5, s1.header.manifestHash),
    );
    await expect(uploadSnapshot(server, skipped)).rejects.toThrow(
      /Expected seq 2/,
    );
  });

  test("an unknown parent is reported as a history gap, not accepted", async () => {
    const { server } = await setup();
    const s1 = buildSnapshot([fileOf("state/a.db", 32, 13)], ctxOf(1, null));
    await uploadSnapshot(server, s1);
    const orphan = buildSnapshot(
      [fileOf("state/a.db", 32, 14)],
      ctxOf(2, "f".repeat(64)),
    );
    const sent = await uploadSnapshot(server, orphan);
    expect(sent.result).toEqual({
      status: "gap",
      latestSeq: 1,
      latestHash: s1.header.manifestHash,
    });
  });

  test("a history gap is answered with a baseline that keeps the old history", async () => {
    const { server, store } = await setup();
    const s1 = buildSnapshot([fileOf("state/a.db", 32, 15)], ctxOf(1, null));
    await uploadSnapshot(server, s1);
    const s2 = buildSnapshot(
      [fileOf("state/a.db", 32, 16)],
      ctxOf(2, s1.header.manifestHash),
    );
    await uploadSnapshot(server, s2);

    // A reinstalled client has lost its chain and believes its parent is old.
    const outcome = await backup(
      server,
      [fileOf("state/a.db", 32, 16), fileOf("state/new.db", 32, 17)],
      ctxOf(2, "e".repeat(64)),
    );
    expect(outcome.baseline).toBe(true);
    expect(outcome.result.status).toBe("committed");
    expect(outcome.snapshot.header.seq).toBe(3);
    expect(outcome.snapshot.header.parent).toBeNull();
    // The unchanged file is reused from the server's chunk store.
    expect(outcome.reused).toBeGreaterThan(0);

    const history = await store.manifests.list(CLIENT);
    expect(history.map((item) => item.header.seq)).toEqual([1, 2, 3]);
  });

  test("a non-gap backup needs no baseline", async () => {
    const { server } = await setup();
    const s1 = buildSnapshot([fileOf("state/a.db", 32, 18)], ctxOf(1, null));
    await uploadSnapshot(server, s1);
    const outcome = await backup(
      server,
      [fileOf("state/a.db", 32, 18), fileOf("state/b.db", 32, 19)],
      ctxOf(2, s1.header.manifestHash),
    );
    expect(outcome.baseline).toBe(false);
    expect(outcome.snapshot.header.seq).toBe(2);
  });
});
