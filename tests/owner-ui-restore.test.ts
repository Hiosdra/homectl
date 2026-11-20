// Owner panel: backup and restore responses (homelab #21 §6). The panel shows
// what the server holds and issues only what the server documents. A response it
// cannot read is refused, and a failed restore says the client may already be
// revoked.
import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  parseRestoreSeq,
  toRestoreIssued,
  toRestorePreview,
} from "../src/web/owner/workspace-restore-api";

const preview = {
  source: "ws-laptop",
  seq: 7,
  createdAt: 1_700_000_000_000,
  bytes: 4096,
  verified: true,
  problems: [],
  seqs: [5, 6, 7],
  files: [
    { path: "settings.json", size: 2048, restorable: true },
    { path: "live/sessions.json", size: 1024, restorable: false },
  ],
};

const issued = {
  code: "R8T-44MW",
  expiresAt: "2026-11-20T10:00:00.000Z",
  restore: { source: "ws-laptop", seq: 7, files: 2, bytes: 2860 },
  server: { id: "ws-server", name: "Home server" },
};

describe("the snapshot preview", () => {
  test("accepts the documented shape", () => {
    expect(toRestorePreview(preview)).toEqual(preview);
  });

  test("an unverified snapshot is still readable, with its problems", () => {
    const parsed = toRestorePreview({
      ...preview,
      verified: false,
      problems: ["integrity check failed at settings.json"],
    });
    expect(parsed?.verified).toBe(false);
    expect(parsed?.problems).toEqual([
      "integrity check failed at settings.json",
    ]);
  });

  test("a file list over the bound, or a wrong type, is refused", () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      path: `f${index}`,
      size: 1,
      restorable: true,
    }));
    expect(toRestorePreview({ ...preview, files: many })).toBeUndefined();
    expect(
      toRestorePreview({
        ...preview,
        files: [{ path: "a", size: "2", restorable: true }],
      }),
    ).toBeUndefined();
    expect(toRestorePreview({ ...preview, seq: -1 })).toBeUndefined();
    expect(toRestorePreview({ ...preview, verified: "yes" })).toBeUndefined();
    expect(toRestorePreview(null)).toBeUndefined();
  });
});

describe("the restore response", () => {
  test("accepts the code, its expiry and the restore summary", () => {
    expect(toRestoreIssued(issued)).toEqual(issued);
  });

  test("an expiry that is not a date is refused, so no code is shown without one", () => {
    expect(toRestoreIssued({ ...issued, expiresAt: "soon" })).toBeUndefined();
  });

  test("a response without the server name is refused", () => {
    expect(
      toRestoreIssued({ ...issued, server: { id: "ws-server" } }),
    ).toBeUndefined();
  });
});

describe("sizes", () => {
  test("bytes, kilobytes and megabytes", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("the version to restore", () => {
  test("blank is the latest snapshot: no seq is sent", () => {
    expect(parseRestoreSeq("")).toEqual({ ok: true, seq: undefined });
    expect(parseRestoreSeq("   ")).toEqual({ ok: true, seq: undefined });
  });

  test("a positive whole number is the version, spaces aside", () => {
    expect(parseRestoreSeq("1")).toEqual({ ok: true, seq: 1 });
    expect(parseRestoreSeq(" 42 ")).toEqual({ ok: true, seq: 42 });
    expect(parseRestoreSeq(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      seq: Number.MAX_SAFE_INTEGER,
    });
  });

  test("zero, negatives, fractions, exponents, words and unsafe numbers are refused", () => {
    for (const text of [
      "0",
      "-1",
      "+3",
      "1.5",
      "1e3",
      "0x10",
      "seven",
      "3 4",
      String(Number.MAX_SAFE_INTEGER + 2),
    ]) {
      const parsed = parseRestoreSeq(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problem).toMatch(/whole number, 1 or more/);
    }
  });
});
