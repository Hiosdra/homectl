import { describe, expect, test } from "bun:test";
import type { PeerState, Version } from "../src/peer/store";
import { capture, merge, validateRecords } from "../src/peer/sync";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function emptyState(id: string): PeerState {
  return {
    version: 1,
    id,
    name: "test",
    key: "k",
    peers: {},
    records: {},
    observed: {},
  };
}

describe("default choice in a conflict is the later change", () => {
  test("a later removal is suggested over an older copy on the other device", () => {
    // Device A removed the machine at t=2000. Device B changed it at t=1000.
    const local: Record<string, Version> = {
      "machine:old-printer": { clock: { [A]: 2 }, value: null, at: 2000 },
    };
    const remote: Record<string, Version> = {
      "machine:old-printer": {
        clock: { [A]: 1, [B]: 1 },
        value: { name: "old-printer" },
        at: 1000,
      },
    };
    const result = merge(local, remote, A);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.suggested).toBe("local");
  });

  test("a later change on the other device is suggested over an older removal", () => {
    const local: Record<string, Version> = {
      "machine:old-printer": { clock: { [A]: 2 }, value: null, at: 1000 },
    };
    const remote: Record<string, Version> = {
      "machine:old-printer": {
        clock: { [A]: 1, [B]: 1 },
        value: { name: "old-printer" },
        at: 2000,
      },
    };
    const result = merge(local, remote, A);
    expect(result.conflicts[0]?.suggested).toBe("remote");
  });

  test("records without a timestamp default to keeping the local version", () => {
    const local: Record<string, Version> = {
      "machine:x": { clock: { [A]: 2 }, value: null },
    };
    const remote: Record<string, Version> = {
      "machine:x": { clock: { [A]: 1, [B]: 1 }, value: { name: "x" } },
    };
    expect(merge(local, remote, A).conflicts[0]?.suggested).toBe("local");
  });

  test("a local change stamps the record with the current time", () => {
    const state = emptyState(A);
    const before = Date.now();
    capture(state, { "machine:x": { name: "x" } }, ["machine:"]);
    const after = Date.now();
    const at = state.records["machine:x"]?.at ?? -1;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  test("a negative or fractional timestamp is refused", () => {
    const base = { clock: { [A]: 1 }, value: 1 };
    expect(() => validateRecords({ "machine:x": { ...base, at: -1 } })).toThrow(
      "Invalid peer revision",
    );
    expect(() =>
      validateRecords({ "machine:x": { ...base, at: 1.5 } }),
    ).toThrow("Invalid peer revision");
    expect(() =>
      validateRecords({ "machine:x": { ...base, at: 1700000000000 } }),
    ).not.toThrow();
  });
});
