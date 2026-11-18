import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PeerState } from "../src/peer/store";
import { capture, filterSnapshotRecords, hash } from "../src/peer/sync";

test("invalid saved-command clocks stay local but are not sent on the wire", () => {
  const deviceId = randomUUID();
  const recordId = "saved-command:not valid";
  const value = { retained: true };
  const version = { clock: { [deviceId]: 3 }, value, at: 1000 };
  const observed = hash(value);
  const state: PeerState = {
    version: 1,
    id: deviceId,
    name: "Local",
    key: "local-key",
    peers: {},
    records: { [recordId]: version },
    observed: { [recordId]: observed },
  };
  const invalid = new Set([recordId]);

  capture(state, {}, ["saved-command:"], invalid);
  const local = filterSnapshotRecords(state.records, {
    forWire: false,
    vaultUnlocked: false,
    features: [],
    invalidSavedCommandIds: invalid,
  });
  const wire = filterSnapshotRecords(state.records, {
    forWire: true,
    vaultUnlocked: true,
    features: ["saved-commands"],
    invalidSavedCommandIds: invalid,
  });

  expect(state.records[recordId]?.clock).toEqual(version.clock);
  expect(state.observed[recordId]).toBe(observed);
  expect(local[recordId]?.clock).toEqual(version.clock);
  expect(wire[recordId]).toBeUndefined();
});
