import { describe, expect, test } from "bun:test";
import type { Version } from "../src/peer/store";
import { merge } from "../src/peer/sync";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// The other device changed its record after this device last saw it.
const remoteNewer = (value: unknown): Version => ({
  clock: { [A]: 1, [B]: 1 },
  value,
  at: 2000,
});
const localOlder = (value: unknown): Version => ({
  clock: { [A]: 1 },
  value,
  at: 1000,
});

describe("partial apply takes only routine changes", () => {
  test("a clean machine add is taken; host keys, credentials and removals are held back", () => {
    const local: Record<string, Version> = {
      "machine:old": { clock: { [A]: 1 }, value: { name: "old" }, at: 1000 },
      "hostkey:lab": localOlder("lab ssh-ed25519 AAAA"),
    };
    const incoming: Record<string, Version> = {
      "machine:new": remoteNewer({ name: "new", access: "sudo" }),
      "hostkey:lab": remoteNewer("lab ssh-ed25519 BBBB"),
      "credential:lab": remoteNewer({ title: "lab", fields: {} }),
      "machine:old": remoteNewer(null),
    };
    const result = merge(local, incoming, A, {}, true);
    expect(result.records["machine:new"]?.value).toEqual({
      name: "new",
      access: "sudo",
    });
    expect(result.records["hostkey:lab"]?.value).toBe("lab ssh-ed25519 AAAA");
    expect(result.records["credential:lab"]).toBeUndefined();
    expect(result.records["machine:old"]?.value).toEqual({ name: "old" });
    expect(result.conflicts).toEqual([]);
  });

  test("a machine that uses a key waits until that key is on this device", () => {
    const withKey = remoteNewer({
      name: "new",
      access: "sudo",
      auth: { type: "keepass", entry: "lab-key" },
    });
    const withoutKey = merge({}, { "machine:new": withKey }, A, {}, true);
    expect(withoutKey.records["machine:new"]).toBeUndefined();

    const withLocalKey = merge(
      { "credential:lab-key": localOlder({ title: "lab-key" }) },
      { "machine:new": withKey },
      A,
      {},
      true,
    );
    expect(withLocalKey.records["machine:new"]?.value).toEqual({
      name: "new",
      access: "sudo",
      auth: { type: "keepass", entry: "lab-key" },
    });
  });

  test("a full apply still takes every change", () => {
    const incoming: Record<string, Version> = {
      "machine:new": remoteNewer({ name: "new" }),
      "credential:lab": remoteNewer({ title: "lab", fields: {} }),
      "machine:old": remoteNewer(null),
    };
    const result = merge(
      { "machine:old": localOlder({ name: "old" }) },
      incoming,
      A,
    );
    expect(result.records["machine:new"]?.value).toEqual({ name: "new" });
    expect(result.records["credential:lab"]?.value).toEqual({
      title: "lab",
      fields: {},
    });
    expect(result.records["machine:old"]?.value).toBeNull();
  });

  test("a conflicting machine stays local in a partial apply and is still reported", () => {
    const local: Record<string, Version> = {
      "machine:x": { clock: { [A]: 2 }, value: { name: "local" }, at: 1000 },
    };
    const incoming: Record<string, Version> = {
      "machine:x": { clock: { [B]: 1 }, value: { name: "remote" }, at: 2000 },
    };
    const result = merge(local, incoming, A, {}, true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.records["machine:x"]?.value).toEqual({ name: "local" });
  });
});
