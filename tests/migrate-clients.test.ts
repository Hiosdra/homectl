import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientRegistry } from "../src/control/clients";
import type { ClientRecord } from "../src/control/types";
import { migrate, type MigrationStep } from "../src/migrate";
import {
  broadenedGrants,
  carryAgentClients,
  downgradeClients,
} from "../src/migrate/step-clients";

// Agent connections: the 0.2 client registry carried into the 0.3 broker.
// Fixtures are fabricated; token values are never created or read.
const dirs: string[] = [];
const clock = () => Date.parse("2026-11-20T11:00:00Z");
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const source: Record<string, ClientRecord> = {
  codex: {
    id: "codex",
    name: "Codex",
    scopes: ["status:read", "inspect:read", "plan:create", "approve:decide"],
    hosts: ["agent-host", "lab-nas"],
    createdAt: 1,
    tokenHash: digest("fixture-token-codex"),
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    scopes: ["status:read", "inspect:read"],
    hosts: ["lab-nas"],
    createdAt: 2,
    tokenHash: digest("fixture-token-claude"),
  },
  retired: {
    id: "retired",
    name: "Retired agent",
    scopes: ["inspect:read", "approve:decide"],
    hosts: ["lab-nas"],
    createdAt: 3,
    tokenHash: digest("fixture-token-retired"),
    revokedAt: 4,
  },
};

async function fixture(clients: Record<string, ClientRecord> | undefined) {
  const workspace = await mkdtemp(join(tmpdir(), "homectl-clients-ws-"));
  const brokerState = await mkdtemp(join(tmpdir(), "homectl-clients-broker-"));
  dirs.push(workspace, brokerState);
  await writeFile(
    join(workspace, "inventory.yaml"),
    "version: 1\nmachines: {}\n",
  );
  if (clients) {
    await mkdir(join(workspace, "control-plane"));
    await writeFile(
      join(workspace, "control-plane", "clients.json"),
      JSON.stringify({ version: 1, clients }),
    );
  }
  return {
    workspace,
    brokerState,
    inventory: join(workspace, "inventory.yaml"),
  };
}

const carried = (brokerState: string) =>
  new ClientRegistry(join(brokerState, "clients.json")).load();
const sourceRegistry = (workspace: string) =>
  new ClientRegistry(join(workspace, "control-plane", "clients.json")).load();

describe("downgradeClients", () => {
  test("drops the retired approve:decide scope and reports it", () => {
    const { clients, dropped } = downgradeClients(source);
    expect(clients.codex?.scopes).toEqual([
      "status:read",
      "inspect:read",
      "plan:create",
    ]);
    expect(clients["claude-code"]?.scopes).toEqual([
      "status:read",
      "inspect:read",
    ]);
    expect(dropped).toEqual([
      { id: "codex", scope: "approve:decide" },
      { id: "retired", scope: "approve:decide" },
    ]);
  });

  test("keeps token digests, host grants, creation times and revocations", () => {
    const { clients } = downgradeClients(source);
    expect(clients.codex?.tokenHash).toBe(source.codex?.tokenHash);
    expect(clients.codex?.hosts).toEqual(["agent-host", "lab-nas"]);
    expect(clients.retired?.revokedAt).toBe(4);
    expect(clients.retired?.createdAt).toBe(3);
  });

  test("does not change the source records", () => {
    const before = JSON.stringify(source);
    downgradeClients(source);
    expect(JSON.stringify(source)).toBe(before);
  });

  test("a malformed record is refused", () => {
    expect(() =>
      downgradeClients({
        bad: {
          id: "bad",
          scopes: "inspect:read",
          hosts: [],
          createdAt: 1,
        } as unknown as ClientRecord,
      }),
    ).toThrow("malformed");
  });
});

describe("broadenedGrants", () => {
  test("a faithful carry reports nothing", () => {
    expect(broadenedGrants(source, downgradeClients(source).clients)).toEqual(
      [],
    );
  });

  test("a gained scope, a gained host, a changed token and a lifted revocation are each reported", () => {
    const carry = structuredClone(downgradeClients(source).clients);
    carry.codex?.scopes.push("proxmox:lxc:restore");
    carry["claude-code"]?.hosts.push("agent-host");
    const other = carry["claude-code"] as ClientRecord;
    other.tokenHash = digest("other");
    const retired = carry.retired as ClientRecord;
    delete retired.revokedAt;
    const problems = broadenedGrants(source, carry);
    expect(problems).toContain(
      "client codex gained scope(s): proxmox:lxc:restore",
    );
    expect(problems).toContain("client claude-code gained a host grant");
    expect(problems).toContain("client claude-code changed its token");
    expect(problems).toContain("client retired lost its revocation");
  });

  test("a lost client, an unknown client and a kept retired scope are reported", () => {
    const carry = structuredClone(downgradeClients(source).clients);
    delete carry["claude-code"];
    carry.stranger = { ...source.codex, id: "stranger" } as ClientRecord;
    carry.codex = {
      ...(carry.codex as ClientRecord),
      scopes: ["approve:decide"],
    };
    const problems = broadenedGrants(source, carry);
    expect(problems).toContain("client claude-code was not carried over");
    expect(problems).toContain("client stranger has no 0.2 record");
    expect(problems).toContain("client codex kept a retired scope");
  });

  test("the message never includes a token digest", () => {
    const carry = structuredClone(downgradeClients(source).clients);
    carry.codex = { ...(carry.codex as ClientRecord), tokenHash: digest("x") };
    const text = broadenedGrants(source, carry).join(" ");
    expect(text).not.toContain(digest("x"));
    expect(text).not.toContain(source.codex?.tokenHash ?? "");
  });
});

describe("v2-carry-agent-clients", () => {
  test("carries the registry with the same tokens, without the retired scope, and nothing wider", async () => {
    const f = await fixture(source);
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [carryAgentClients],
    });
    expect(result.status).toBe("migrated");
    const after = await carried(f.brokerState);
    expect(after.codex?.scopes).not.toContain("approve:decide");
    expect(after.codex?.tokenHash).toBe(source.codex?.tokenHash);
    expect(broadenedGrants(await sourceRegistry(f.workspace), after)).toEqual(
      [],
    );
    if (result.status === "migrated")
      expect(result.notes.join(" ")).toContain(
        "Client codex: scope approve:decide was dropped",
      );
  });

  test("a second run leaves the broker file byte-identical", async () => {
    const f = await fixture(source);
    await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [carryAgentClients],
    });
    const once = await readFile(join(f.brokerState, "clients.json"), "utf8");
    await carryAgentClients.run({
      workspace: f.workspace,
      inventoryPath: f.inventory,
      brokerState: f.brokerState,
      now: clock(),
      note: () => undefined,
    });
    expect(await readFile(join(f.brokerState, "clients.json"), "utf8")).toBe(
      once,
    );
  });

  test("no 0.2 clients means no broker file is written", async () => {
    const f = await fixture(undefined);
    const result = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [carryAgentClients],
    });
    expect(result.status).toBe("migrated");
    expect(
      await new ClientRegistry(join(f.brokerState, "clients.json")).load(),
    ).toEqual({});
  });

  test("a broker registry that already differs is refused and nothing changes", async () => {
    const f = await fixture(source);
    const other = { other: { ...source.codex, id: "other" } as ClientRecord };
    await writeFile(
      join(f.brokerState, "clients.json"),
      JSON.stringify({ version: 1, clients: other }),
    );
    await expect(
      migrate(f.inventory, {
        clock,
        brokerState: f.brokerState,
        steps: [carryAgentClients],
      }),
    ).rejects.toThrow("rolled back");
    expect(await carried(f.brokerState)).toEqual(other);
  });

  test("a carry that widens access fails verification and is rolled back", async () => {
    const f = await fixture(source);
    // Simulates a faulty carry: run correctly, then add a scope before verify.
    const widening: MigrationStep = {
      ...carryAgentClients,
      async run(context) {
        await carryAgentClients.run(context);
        const path = join(context.brokerState, "clients.json");
        const registry = await new ClientRegistry(path).load();
        registry.codex = {
          ...(registry.codex as ClientRecord),
          scopes: [...(registry.codex?.scopes ?? []), "proxmox:lxc:restore"],
        };
        await writeFile(
          path,
          JSON.stringify({ version: 1, clients: registry }),
        );
      },
    };
    const failure = await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [widening],
    }).then(
      () => undefined,
      (error: { message: string; details?: { reason?: string } }) => error,
    );
    expect(failure?.message).toContain("rolled back");
    expect(failure?.details?.reason).toContain(
      "gained scope(s): proxmox:lxc:restore",
    );
    // The broker file did not exist before, so rollback removes it.
    await expect(
      readFile(join(f.brokerState, "clients.json")),
    ).rejects.toThrow();
  });

  test("a revoked client stays revoked after the carry", async () => {
    const f = await fixture(source);
    await migrate(f.inventory, {
      clock,
      brokerState: f.brokerState,
      steps: [carryAgentClients],
    });
    expect((await carried(f.brokerState)).retired?.revokedAt).toBe(4);
  });
});
