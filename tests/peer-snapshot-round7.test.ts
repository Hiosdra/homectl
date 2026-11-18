import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInventory } from "../src/inventory";
import { snapshotWithIssues } from "../src/peer/snapshot";
import type { PeerState, Version } from "../src/peer/store";
import type { SavedCommandStore } from "../src/saved-commands";
import { keyReference } from "../src/session/keys";

test.each(["EACCES", "EPERM", "EBUSY", "EISDIR"])(
  "isolates saved-command snapshot read error %s",
  async (code) => {
    const dir = await mkdtemp(join(tmpdir(), "homectl-snapshot-read-error-"));
    try {
      const inventoryPath = join(dir, "inventory.yaml");
      await saveInventory(inventoryPath, {
        version: 1,
        session: { ttl: "24h", database: join(dir, "vault.kdbx") },
        machines: {
          nas: {
            description: "Synthetic NAS",
            transport: "ssh",
            address: "192.0.2.10",
            ssh_alias: "nas",
            user: "operator",
            access: "observe",
            auth: keyReference("nas", inventoryPath),
          },
        },
      });
      await writeFile(
        join(dir, "known_hosts"),
        "192.0.2.10 ssh-ed25519 AQID\n",
      );
      const deviceId = randomUUID();
      const savedId = "saved-command:preserve-me";
      const priorSaved: Version = {
        clock: { [deviceId]: 1 },
        value: { retained: true },
        at: 1000,
      };
      const state: PeerState = {
        version: 1,
        id: deviceId,
        name: "Local",
        key: "local-key",
        peers: {},
        records: { [savedId]: priorSaved },
        observed: { [savedId]: "prior-hash" },
      };
      const readError = Object.assign(new Error("saved-command read failed"), {
        code,
      });
      const savedCommands = {
        listWithIssues: async () => {
          throw readError;
        },
      } as unknown as SavedCommandStore;
      const snapshot = await snapshotWithIssues(
        {
          inventoryPath,
          state,
          savedCommands,
          vault: {
            unlocked: true,
            snapshot: () => ({
              session: {
                title: "homectl-session",
                fields: { Title: "homectl-session" },
                attachments: {},
              },
            }),
          },
          save: async () => {},
        },
        true,
      );

      expect(snapshot.records["machine:nas"]).toBeDefined();
      expect(snapshot.records["credential:session"]).toBeDefined();
      expect(
        Object.keys(snapshot.records).some((id) => id.startsWith("hostkey:")),
      ).toBe(true);
      expect(state.records[savedId]).toEqual(priorSaved);
      expect(state.observed[savedId]).toBe("prior-hash");
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({
          id: "saved-commands",
          reason: expect.stringContaining("could not be read"),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
