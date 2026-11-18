import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedCommandStore } from "../src/saved-commands";

test("failed sync rollback preserves a concurrent writer's newer file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-saved-command-rollback-"));
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const path = join(dir, "saved-commands.json");
    const store = new SavedCommandStore(path);
    const saved = await store.save({
      name: "Restart service",
      hosts: ["example"],
      argv: ["systemctl", "restart", "{{unit}}"],
      parameters: [{ name: "unit", description: "Service unit" }],
      description: "Restart one named service",
    });
    const incoming = {
      ...saved,
      name: "Synced replacement",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    const newerContents = JSON.stringify({
      version: 1,
      commands: { [saved.id]: { ...saved, name: "Concurrent writer" } },
    });

    await expect(
      store.replaceFromRecordsWith(
        { [`saved-command:${saved.id}`]: { value: incoming } },
        undefined,
        async () => {
          await writeFile(path, newerContents);
          throw new Error("simulated peer-state save failure");
        },
      ),
    ).rejects.toThrow("simulated peer-state save failure");

    expect(await readFile(path, "utf8")).toBe(newerContents);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("rollback was skipped"),
    );
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
