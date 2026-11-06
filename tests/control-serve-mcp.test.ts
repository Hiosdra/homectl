import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlCliInput } from "../src/control/cli";
import { mcpControl } from "../src/control/cli";
import type { ClientIdentity } from "../src/control/types";
import { serve } from "../src/serve";

// Synthetic local device. serve-mcp must use the running serve as the single
// writer, not open a second control plane beside it.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "homectl-serve-mcp-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(
    inventoryPath,
    `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`,
  );
  const input: ControlCliInput = {
    inventoryPath,
    configPath: `${inventoryPath}.ssh_config`,
    positionals: ["mcp"],
    values: {},
    dryRun: false,
    json: true,
  };
  return { inventoryPath, input };
}

describe("serve-mcp and a running serve", () => {
  test("without a running serve, serve-mcp uses a local plane", async () => {
    const w = await workspace();
    const { served } = await mcpControl(w.input);
    expect(served).toBe(false);
  });

  test("with a running serve, serve-mcp forwards to it: one writer, the same state", async () => {
    const w = await workspace();
    const running = await serve({
      inventoryPath: w.inventoryPath,
      configPath: w.input.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
    });
    cleanup.push(() => running.stop());
    const token = await running.control.createClient({
      id: "codex-pc",
      name: "Codex PC",
      scopes: ["plan:create", "inspect:read"],
      hosts: ["agent-host"],
    });
    const { control, served } = await mcpControl(w.input);
    expect(served).toBe(true);
    const client = (await control.authenticate(
      token.token as string,
    )) as ClientIdentity;
    expect(client.id).toBe("codex-pc");
    const planned = (await control.request(
      { kind: "client", client },
      { op: "plan", host: "agent-host", argv: ["uname", "-s"] },
    )) as { operationId: string };
    // The plan was written by the running serve, which is the only writer.
    const held = await running.control.listOperations({ all: true });
    expect(held.some((o) => o.operationId === planned.operationId)).toBe(true);
    expect(await control.authenticate("hct_not-a-real-token")).toBeNull();
  });
});
