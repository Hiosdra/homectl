import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_VERSION,
  detectVersion,
  MARKER_FILE,
  type MigrationContext,
  type MigrationStep,
  migrate,
} from "../src/migrate";
import { STEPS } from "../src/migrate/steps";
import {
  retirePendingAuthority,
  retireSigningAuthority,
} from "../src/migrate/step-state";
import {
  reportPreservedInPlace,
  verifyInventoryAndVault,
} from "../src/migrate/step-trust";

// Fixture-based tests for each migration step. Every fixture is a fabricated
// 0.2 workspace in a temp directory; no real homectl state is read.
const dirs: string[] = [];
const clock = () => Date.parse("2026-11-20T09:00:00Z");
const digest = (text: Buffer | string) =>
  createHash("sha256").update(text).digest("hex");

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  workspace: string;
  inventory: string;
  database: string;
  brokerState: string;
}

const legacyState = {
  version: 1,
  operations: {
    pend: { state: "pending", updatedAt: 1 },
    appr: {
      state: "approved",
      updatedAt: 1,
      approval: { id: "grant-1", nonce: "n" },
    },
    exec: { state: "executing", updatedAt: 1, spawnAttempted: false },
    done: { state: "succeeded", updatedAt: 1, finishedAt: 1 },
  },
  consumedNonces: ["n1"],
};

const legacyClients = {
  version: 1,
  clients: {
    codex: {
      id: "codex",
      name: "Codex",
      scopes: ["status:read", "inspect:read", "plan:create", "approve:decide"],
      hosts: ["agent-host", "lab-nas"],
      createdAt: 1,
      tokenHash: digest("fixture-token-codex"),
    },
    retired: {
      id: "retired",
      name: "Retired agent",
      scopes: ["inspect:read"],
      hosts: ["lab-nas"],
      createdAt: 2,
      tokenHash: digest("fixture-token-retired"),
      revokedAt: 3,
    },
  },
};

async function legacyWorkspace(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-migrate-steps-"));
  dirs.push(dir);
  const brokerDir = await mkdtemp(join(tmpdir(), "homectl-broker-state-"));
  dirs.push(brokerDir);
  const inventory = join(dir, "inventory.yaml");
  const database = join(dir, "homelab.kdbx");
  await writeFile(
    inventory,
    [
      "version: 1",
      "session:",
      "  ttl: 24h",
      `  database: ${JSON.stringify(database)}`,
      "machines:",
      "  agent-host:",
      "    description: Local machine",
      "    transport: local",
      "    access: observe",
      "  lab-nas:",
      "    description: NAS",
      "    transport: ssh",
      "    ssh_alias: lab-nas",
      "    address: 192.0.2.11",
      "    user: operator",
      "    access: sudo-approved",
      "    auth:",
      "      type: keepassxc",
      "      entry: homectl-lab-nas",
      `      socket: ${JSON.stringify(`${inventory}.session/agent.sock`)}`,
      `      public_key: ${JSON.stringify(join(dir, "public-keys", "lab-nas.pub"))}`,
      "    sudo_allow:",
      "      - - /usr/bin/systemctl",
      "        - restart",
      "        - klipper",
      "",
    ].join("\n"),
  );
  await writeFile(database, "fixture database bytes, never opened");
  await mkdir(join(dir, "control-plane"));
  await writeFile(
    join(dir, "control-plane", "state.json"),
    JSON.stringify(legacyState),
  );
  await writeFile(
    join(dir, "control-plane", "clients.json"),
    JSON.stringify(legacyClients),
  );
  await writeFile(
    join(dir, "control-plane", "device-key.json"),
    '{"fixture":"0.2 device key"}',
  );
  await writeFile(
    join(dir, "control-plane", "replica.json"),
    '{"fixture":"0.2 replica"}',
  );
  await writeFile(join(dir, "control-plane", "audit.jsonl"), '{"seq":1}\n');
  await writeFile(join(dir, "control-plane", "audit.anchor"), '{"seq":1}');
  await writeFile(
    join(dir, "known_hosts"),
    "@revoked lab-old ssh-ed25519 AAAAFIXTUREREVOKED\nlab-nas ssh-ed25519 AAAAFIXTUREPINNED\n",
  );
  await mkdir(join(dir, "public-keys"));
  await writeFile(
    join(dir, "public-keys", "lab-nas.pub"),
    "ssh-ed25519 AAAAFIXTUREPUB\n",
  );
  await writeFile(join(dir, "saved-commands.json"), '{"version":1}');
  await writeFile(join(dir, "peers.json"), '{"version":1,"peers":{}}');
  // A 0.2 session agent socket: runtime state that must never come back.
  await mkdir(`${inventory}.session`);
  await writeFile(
    join(`${inventory}.session`, "agent.sock"),
    "stale 0.2 session fixture",
  );
  return { workspace: dir, inventory, database, brokerState: brokerDir };
}

// Digest of every workspace file, except the migration's own backups.
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      if (dir === root && name === "backups") continue;
      if (
        await readdir(path).then(
          () => true,
          () => false,
        )
      )
        await walk(path);
      else
        out[
          path
            .slice(root.length + 1)
            .split("\\")
            .join("/")
        ] = digest(await readFile(path));
    }
  }
  await walk(root);
  return out;
}

function contextFor(fixture: Fixture): MigrationContext {
  return {
    workspace: fixture.workspace,
    inventoryPath: fixture.inventory,
    brokerState: fixture.brokerState,
    now: clock(),
    note: () => undefined,
  };
}

const readState = async (f: Fixture) =>
  JSON.parse(
    await readFile(join(f.workspace, "control-plane", "state.json"), "utf8"),
  );

describe("v2-retire-pending-authority", () => {
  test("closes open operations, keeps history, and a second run changes nothing", async () => {
    const f = await legacyWorkspace();
    await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [retirePendingAuthority],
    });
    const once = await readState(f);
    expect(once.operations.pend.state).toBe("failed");
    expect(once.operations.appr.state).toBe("failed");
    expect(once.operations.exec.state).toBe("unknown");
    expect(once.operations.done.state).toBe("succeeded");
    // Running the step again on its own leaves the file byte-identical.
    const bytes = await readFile(
      join(f.workspace, "control-plane", "state.json"),
      "utf8",
    );
    await retirePendingAuthority.run(contextFor(f));
    await retirePendingAuthority.verify(contextFor(f));
    expect(
      await readFile(join(f.workspace, "control-plane", "state.json"), "utf8"),
    ).toBe(bytes);
  });

  test("a retired approval is never honoured again and nothing reopens", async () => {
    const f = await legacyWorkspace();
    await migrate(f.inventory, { clock, brokerState: f.brokerState });
    const state = await readState(f);
    for (const op of Object.values(state.operations) as { state: string }[])
      expect(["pending", "approved", "executing"]).not.toContain(op.state);
    // The approval object stays as evidence; the operation is no longer approved.
    expect(state.operations.appr.approval).toBeDefined();
    expect(state.operations.appr.state).not.toBe("approved");
  });

  test("when its own verification fails, the closed operations are rolled back", async () => {
    const f = await legacyWorkspace();
    const before = await readFile(
      join(f.workspace, "control-plane", "state.json"),
      "utf8",
    );
    const reopened: MigrationStep = {
      ...retirePendingAuthority,
      async run(context) {
        await retirePendingAuthority.run(context);
        // A faulty step that leaves an operation open must not be committed.
        await writeFile(
          join(f.workspace, "control-plane", "state.json"),
          JSON.stringify({
            version: 1,
            operations: { x: { state: "approved" } },
          }),
        );
      },
    };
    await expect(
      migrate(f.inventory, {
        clock,
        brokerState: f.brokerState,
        steps: [reopened],
      }),
    ).rejects.toThrow("rolled back");
    expect(
      await readFile(join(f.workspace, "control-plane", "state.json"), "utf8"),
    ).toBe(before);
    expect(await detectVersion(f.inventory)).toBe(2);
  });

  test("a corrupt state file is refused and the workspace is restored", async () => {
    const f = await legacyWorkspace();
    await writeFile(
      join(f.workspace, "control-plane", "state.json"),
      "{not json",
    );
    await expect(
      migrate(f.inventory, {
        clock,
        brokerState: f.brokerState,
        steps: [retirePendingAuthority],
      }),
    ).rejects.toThrow("rolled back");
    expect(
      await readFile(join(f.workspace, "control-plane", "state.json"), "utf8"),
    ).toBe("{not json");
    expect(await detectVersion(f.inventory)).toBe(2);
  });
});

describe("v2-retire-signing-and-sessions", () => {
  test("the 0.2 device key, replica and session socket are not carried into 0.3", async () => {
    const f = await legacyWorkspace();
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
    });
    expect(result.status).toBe("migrated");
    // The only file the broker receives is the carried client registry.
    expect(await readdir(f.brokerState)).toEqual(["clients.json"]);
    const session = await readFile(
      join(`${f.inventory}.session`, "agent.sock"),
      "utf8",
    );
    expect(session).toBe("stale 0.2 session fixture");
    if (result.status === "migrated")
      expect(result.notes.join(" ")).toContain(
        "0.2 device signing key was not carried",
      );
  });

  test("a 0.2 signing key copied into the broker is refused and rolled back", async () => {
    const f = await legacyWorkspace();
    await mkdir(join(f.brokerState, "keys"), { recursive: true });
    const copied = await readFile(
      join(f.workspace, "control-plane", "device-key.json"),
    );
    await writeFile(join(f.brokerState, "keys", "device-key.json"), copied);
    await expect(
      migrate(f.inventory, {
        clock,
        brokerState: f.brokerState,
        steps: [retireSigningAuthority],
      }),
    ).rejects.toThrow("rolled back");
    expect(await detectVersion(f.inventory)).toBe(2);
  });
});

describe("v2-verify-inventory-and-trust", () => {
  test("an inventory 0.3 cannot read stops the migration and leaves it unchanged", async () => {
    const f = await legacyWorkspace();
    const before = await tree(f.workspace);
    await writeFile(f.inventory, "version: 1\nmachines: not-a-map\n");
    await expect(
      migrate(f.inventory, {
        clock,
        brokerState: f.brokerState,
        steps: [verifyInventoryAndVault],
      }),
    ).rejects.toThrow("rolled back");
    const after = await tree(f.workspace);
    expect(after).toEqual({
      ...before,
      "inventory.yaml": digest("version: 1\nmachines: not-a-map\n"),
    });
    expect(await detectVersion(f.inventory)).toBe(2);
  });

  test("host trust and owner access are reported and known_hosts is byte-identical", async () => {
    const f = await legacyWorkspace();
    const hosts = await readFile(join(f.workspace, "known_hosts"), "utf8");
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [verifyInventoryAndVault],
    });
    expect(await readFile(join(f.workspace, "known_hosts"), "utf8")).toBe(
      hosts,
    );
    if (result.status !== "migrated") throw new Error("expected migrated");
    const notes = result.notes.join("\n");
    expect(notes).toContain("1 @revoked line(s) stay revoked");
    expect(notes).toContain("Owner access: the vault master password");
  });

  test("running the verification twice is idempotent", async () => {
    const f = await legacyWorkspace();
    await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [verifyInventoryAndVault],
    });
    const once = await tree(f.workspace);
    await verifyInventoryAndVault.run(contextFor(f));
    await verifyInventoryAndVault.verify(contextFor(f));
    expect(await tree(f.workspace)).toEqual(once);
  });
});

describe("v2-report-preserved-and-agent-config", () => {
  test("history, saved commands, peers, keys and the vault are byte-identical after a full migration", async () => {
    const f = await legacyWorkspace();
    const before = await tree(f.workspace);
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
    });
    expect(result.status).toBe("migrated");
    const after = await tree(f.workspace);
    for (const kept of [
      "known_hosts",
      "homelab.kdbx",
      "public-keys/lab-nas.pub",
      "peers.json",
      "saved-commands.json",
      "control-plane/audit.jsonl",
      "control-plane/audit.anchor",
      "control-plane/replica.json",
      "control-plane/device-key.json",
    ]) {
      expect(after[kept]).toBe(before[kept]);
    }
  });

  test("the notes say which access narrowed and which agent config the owner must refresh", async () => {
    const f = await legacyWorkspace();
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [reportPreservedInPlace],
    });
    if (result.status !== "migrated") throw new Error("expected migrated");
    const notes = result.notes.join("\n");
    expect(notes).toContain("Access narrowed from 0.2");
    expect(notes).toContain("home-ctl agent connect");
  });
});

describe("full chain on a 0.2 fixture", () => {
  test("version marker is written last and the chain is the step list", async () => {
    const f = await legacyWorkspace();
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
    });
    if (result.status !== "migrated") throw new Error("expected migrated");
    expect(result.steps).toEqual(STEPS.map((step: MigrationStep) => step.id));
    expect(await detectVersion(f.inventory)).toBe(DATA_VERSION);
    const marker = JSON.parse(
      await readFile(join(f.workspace, MARKER_FILE), "utf8"),
    );
    expect(marker.history[0]).toMatchObject({ from: 2, to: 3 });
    expect(
      (await readdir(f.workspace)).includes("migration-progress.json"),
    ).toBe(false);
  });
});
