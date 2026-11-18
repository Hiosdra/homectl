import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandHistoryStore,
  type LocalCommandHistoryInput,
} from "../src/command-history";
import type {
  AuditHistoryPage,
  AuditHistoryRecord,
} from "../src/control/audit-view";
import type { ControlPlane } from "../src/control/engine";
import type { Hub } from "../src/peer/hub";
import { auditCommandsRoute } from "../src/web/audit-commands-route";

const controlRecord: AuditHistoryRecord = {
  source: "control-plane",
  cursorAt: "2026-11-18T12:00:00.000Z",
  creationSequence: 1,
  row: {
    id: "control-row",
    sequence: 1,
    at: "2026-11-18T12:00:00.000Z",
    source: "control-plane",
    requester: "local-operator",
    policyDecision: "allowed",
    status: "succeeded",
  },
};

function historyInput(operationId: string): LocalCommandHistoryInput {
  return {
    inventoryPath: "inventory.yaml",
    host: "nas",
    argv: ["hostname"],
    phase: "outcome",
    status: "succeeded",
    policyDecision: "allowed",
    operationId,
    finishedAt: Date.now(),
  };
}

function controlPlane(overrides: Record<string, unknown> = {}) {
  return {
    listClients: async () => [],
    auditRows: async () => [controlRecord],
    ...overrides,
  } as unknown as ControlPlane;
}

async function getAudit(
  inventoryPath: string,
  control: ControlPlane,
): Promise<AuditHistoryPage> {
  const url = new URL("http://localhost/api/audit");
  const response = await auditCommandsRoute(new Request(url), url, {
    control,
    hub: {} as Hub,
    inventoryPath,
    configPath: "",
  });
  if (!response) throw new Error("Audit route did not handle the request");
  return (await response.json()) as AuditHistoryPage;
}

function nonRootUid(): number | undefined {
  return process.getuid?.() === 0 ? 1000 : process.getuid?.();
}

test("audit route reports malformed history and keeps control-plane rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-audit-route-malformed-"));
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const store = new CommandHistoryStore(inventoryPath, {
      getUid: nonRootUid,
      warn: () => {},
    });
    await store.append(historyInput("local-row"));
    await writeFile(
      store.path,
      `${await readFile(store.path, "utf8")}{invalid json\n`,
    );

    const page = await getAudit(inventoryPath, controlPlane());
    expect(page.malformedHistoryLines).toBe(1);
    expect(page.warnings).toContain(
      "Skipped 1 malformed local command history line.",
    );
    expect(page.entries.map((entry) => entry.source).sort()).toEqual([
      "command-history",
      "control-plane",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit route keeps local history when control-plane reads fail", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "homectl-audit-route-control-failure-"),
  );
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    await new CommandHistoryStore(inventoryPath, {
      getUid: nonRootUid,
      warn: () => {},
    }).append(historyInput("local-row"));
    const control = controlPlane({
      listClients: async () => {
        throw new Error("unavailable");
      },
    });

    const page = await getAudit(inventoryPath, control);
    expect(page.entries.map((entry) => entry.source)).toEqual([
      "command-history",
    ]);
    expect(page.warnings).toContain(
      "Control-plane audit history is unavailable.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit route keeps control-plane rows when local history reads fail", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "homectl-audit-route-history-failure-"),
  );
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    await mkdir(join(dir, "history", "commands.jsonl"), { recursive: true });

    const page = await getAudit(inventoryPath, controlPlane());
    expect(page.entries.map((entry) => entry.source)).toEqual([
      "control-plane",
    ]);
    expect(page.warnings).toContain("Local command history is unavailable.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
