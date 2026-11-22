import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/control/file-lock";

setDefaultTimeout(60_000);

test("refreshes a lock while a long callback holds it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-file-lock-heartbeat-"));
  try {
    let entered!: () => void;
    let release!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPath = join(dir, "saved-commands.json.lock");
    const options = { staleMs: 75, heartbeatMs: 10, waitMs: 1000 };
    const first = withFileLock(
      lockPath,
      "Saved commands",
      async () => {
        entered();
        await gate;
      },
      options,
    );
    await lockEntered;
    await Bun.sleep(120);

    let secondAcquired = false;
    const second = withFileLock(
      lockPath,
      "Saved commands",
      async () => {
        secondAcquired = true;
      },
      options,
    );
    await Bun.sleep(120);
    expect(secondAcquired).toBe(false);

    release();
    await first;
    await second;
    expect(secondAcquired).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
