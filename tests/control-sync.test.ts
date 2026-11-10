import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import { ControlPlane } from "../src/control/engine";
import { backoffMs } from "../src/control/lease";
import { ControlReplicator } from "../src/control/replicator";
import { SYNC_INTERVAL_MS, SyncLoop } from "../src/control/sync-loop";

setDefaultTimeout(60_000);

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function device(name: string, clock: { now: number }) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-sync-"));
  dirs.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const stateDirectory = join(dir, "control-plane");
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory,
    clock: () => clock.now,
  });
  await plane.init();
  const key = await loadOrCreateDeviceKey(stateDirectory);
  const rep = await ControlReplicator.open({
    plane,
    stateDirectory,
    self: { id: randomUUID(), name, key },
    clock: () => clock.now,
  });
  return { name, plane, rep, key };
}

describe("continuous sync", () => {
  test("a round delivers records, and last-sync status is recorded per peer", async () => {
    const clock = { now: 1_000_000 };
    const a = await device("A", clock);
    const b = await device("B", clock);
    await a.rep.addPeer(b.rep.self.id, "B", b.key.publicKey);
    await b.rep.addPeer(a.rep.self.id, "A", a.key.publicKey);
    const loop = new SyncLoop(
      a.rep,
      async (_id, request) => b.rep.serve(request),
      () => clock.now,
    );
    const result = await loop.tick();
    expect(result[b.rep.self.id]).toMatchObject({
      applied: expect.any(Number),
      blocked: [],
    });
    const [status] = loop.statuses();
    expect(status?.lastSync).toBe(clock.now);
    expect(status?.failures).toBe(0);
    expect(status?.lastError).toBeUndefined();
  });

  test("an offline peer is retried with growing backoff, not on every round", async () => {
    const clock = { now: 2_000_000 };
    const a = await device("A", clock);
    const b = await device("B", clock);
    await a.rep.addPeer(b.rep.self.id, "B", b.key.publicKey);
    let attempts = 0;
    const loop = new SyncLoop(
      a.rep,
      async () => {
        attempts += 1;
        throw new Error("peer unreachable");
      },
      () => clock.now,
    );
    await loop.tick();
    expect(attempts).toBe(1);
    expect(loop.statuses()[0]?.failures).toBe(1);
    expect(loop.statuses()[0]?.nextAttemptAt).toBe(clock.now + backoffMs(1));
    // Still inside the backoff: no attempt is made.
    await loop.tick();
    expect(attempts).toBe(1);
    clock.now += backoffMs(1);
    await loop.tick();
    expect(attempts).toBe(2);
    expect(loop.statuses()[0]?.failures).toBe(2);
    expect(loop.statuses()[0]?.lastError).toBe("peer unreachable");
  });

  test("a peer paired before signing keys existed is refused, never contacted", async () => {
    const clock = { now: 3_000_000 };
    const a = await device("A", clock);
    const legacy = await device("Legacy", clock);
    await a.rep.addPeer(legacy.rep.self.id, "Legacy");
    let attempts = 0;
    const loop = new SyncLoop(
      a.rep,
      async () => {
        attempts += 1;
        throw new Error("should not be called");
      },
      () => clock.now,
    );
    const result = await loop.tick();
    expect(result[legacy.rep.self.id]).toBe("refused");
    expect(attempts).toBe(0);
    expect(loop.statuses()[0]?.refused).toContain("Re-pair this device");
  });

  test("recovery after an outage resets the failure count and the interval", async () => {
    const clock = { now: 4_000_000 };
    const a = await device("A", clock);
    const b = await device("B", clock);
    await a.rep.addPeer(b.rep.self.id, "B", b.key.publicKey);
    let up = false;
    const loop = new SyncLoop(
      a.rep,
      async (_id, request) => {
        if (!up) throw new Error("down");
        return b.rep.serve(request);
      },
      () => clock.now,
    );
    await loop.tick();
    expect(loop.statuses()[0]?.failures).toBe(1);
    up = true;
    clock.now += backoffMs(1);
    await loop.tick();
    expect(loop.statuses()[0]?.failures).toBe(0);
    expect(loop.statuses()[0]?.nextAttemptAt).toBe(
      clock.now + SYNC_INTERVAL_MS,
    );
  });
});
