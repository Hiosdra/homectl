import { describe, expect, test } from "bun:test";
import { buildSnapshot, CHUNK_SIZE, newClientKey } from "../src/backup";
import { parseManifest } from "../src/backup/types";
import {
  CLIENT,
  codeOf,
  EMPTY_SHA256,
  fileOf,
  SMALL_CHUNK,
} from "./backup-helpers";

const key = newClientKey();
const base = {
  client: CLIENT,
  key,
  seq: 1,
  parent: null,
  now: 1_700_000_000_000,
};

describe("backup snapshots", () => {
  test("chunk size defaults to 1 MiB and can be overridden per snapshot", () => {
    expect(CHUNK_SIZE).toBe(1024 * 1024);
    const snapshot = buildSnapshot([fileOf("state/a.db", 40, 1)], {
      ...base,
      chunkSize: SMALL_CHUNK,
    });
    expect(snapshot.manifest.files[0]?.chunks.length).toBe(3);
    expect(snapshot.chunks.size).toBe(3);
  });

  test("an empty file has no chunks and still appears in the manifest", () => {
    const snapshot = buildSnapshot([fileOf("state/empty.db", 0, 1)], base);
    expect(snapshot.manifest.files).toEqual([
      { path: "state/empty.db", size: 0, sha256: EMPTY_SHA256, chunks: [] },
    ]);
    expect(snapshot.chunks.size).toBe(0);
  });

  test("the same input and clock give the same manifest hash", () => {
    const input = [fileOf("state/a.db", 33, 2), fileOf("state/b.db", 9, 3)];
    const first = buildSnapshot(input, { ...base, chunkSize: SMALL_CHUNK });
    const second = buildSnapshot(input, { ...base, chunkSize: SMALL_CHUNK });
    expect(second.header.manifestHash).toBe(first.header.manifestHash);
    expect(second.header.chunks).toEqual(first.header.chunks);
  });

  test("header lists distinct chunk ids and the total byte count", () => {
    const snapshot = buildSnapshot(
      [fileOf("state/a.db", 32, 4), fileOf("state/copy.db", 32, 4)],
      { ...base, chunkSize: SMALL_CHUNK },
    );
    expect(snapshot.header.bytes).toBe(64);
    expect(snapshot.header.chunks.length).toBe(snapshot.chunks.size);
    expect(new Set(snapshot.header.chunks).size).toBe(
      snapshot.header.chunks.length,
    );
  });

  test("path policy rejects absolute, traversal, backslash and empty-segment paths", () => {
    const bad = [
      "/etc/passwd",
      "C:/x",
      "../x",
      "a/../b",
      "a\\b",
      "a//b",
      "./a",
      "",
    ];
    for (const path of bad)
      expect(() =>
        buildSnapshot([{ path, data: new Uint8Array(1) }], base),
      ).toThrow();
    expect(() =>
      buildSnapshot([fileOf("state/app.db", 1, 1)], base),
    ).not.toThrow();
  });

  test("runtime and ephemeral paths are refused with policy code 3", async () => {
    const excluded = [
      "state/app.session",
      "state/agent.sock",
      "state/db.lock",
      "secrets-ephemeral/token.bin",
      "data/approvals-pending/req-1.json",
      "STATE/Upper.SESSION",
      "broker/keys/device-key.json",
      "broker/owner.json",
      "broker/runtime/endpoint.json",
      "broker/consumed-approvals.json",
      "broker/broker-state.json",
    ];
    const valid = buildSnapshot([fileOf("state/allowed.db", 1, 1)], base);
    const [file] = valid.manifest.files;
    for (const path of excluded) {
      expect(
        await codeOf(() =>
          parseManifest({ ...valid.manifest, files: [{ ...file, path }] }),
        ),
      ).toBe(3);
      expect(
        await codeOf(() =>
          buildSnapshot([{ path, data: new Uint8Array(1) }], base),
        ),
      ).toBe(3);
    }
  });

  test("duplicate paths are refused", () => {
    expect(() =>
      buildSnapshot(
        [fileOf("state/a.db", 1, 1), fileOf("state/a.db", 1, 2)],
        base,
      ),
    ).toThrow(/Duplicate/);
  });

  test("invalid client, seq, parent and chunk size are refused", () => {
    expect(() =>
      buildSnapshot([], { ...base, client: "Bad Client" }),
    ).toThrow();
    expect(() => buildSnapshot([], { ...base, seq: 0 })).toThrow();
    expect(() =>
      buildSnapshot([], { ...base, parent: "not-a-hash" }),
    ).toThrow();
    expect(() => buildSnapshot([], { ...base, chunkSize: 0 })).toThrow();
  });
});
