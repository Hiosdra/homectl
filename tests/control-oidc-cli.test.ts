import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlCommand } from "../src/control/cli";

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const SUBJECT = "subject-cli-7";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-oidc-cli-"));
  dirs.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  return { dir, inventoryPath, configPath: join(dir, "ssh_config") };
}

function run(
  ws: { inventoryPath: string; configPath: string },
  positionals: string[],
  values: Record<string, string | boolean | undefined> = {},
) {
  return controlCommand({
    inventoryPath: ws.inventoryPath,
    configPath: ws.configPath,
    positionals,
    values: values as never,
    dryRun: false,
    json: true,
    color: false,
  });
}

describe("control oidc and OIDC client mapping from the CLI", () => {
  test("set, show, add a mapped client, list it without the subject, then clear", async () => {
    const ws = await workspace();
    const set = await run(ws, ["oidc", "set"], {
      issuer: "https://idp.example.test",
      audience: "homectl-mcp",
    });
    expect(set.value).toMatchObject({
      configured: true,
      issuerHost: "idp.example.test",
    });

    const shown = await run(ws, ["oidc", "show"]);
    expect(shown.value).toMatchObject({
      configured: true,
      issuerHost: "idp.example.test",
      mappedClients: 0,
    });

    const tokenFile = join(ws.dir, "oidc-codex.token");
    await run(ws, ["client", "add", "oidc-codex"], {
      name: "OIDC Codex",
      scopes: "status:read",
      hosts: "agent-host",
      "token-file": tokenFile,
      "oidc-subject": SUBJECT,
    });
    // The static token is still written to the owner-only file, as before.
    expect((await readFile(tokenFile, "utf8")).startsWith("hct_")).toBe(true);

    const listed = await run(ws, ["client", "list"]);
    const clients = (
      listed.value as { clients: { id: string; oidc?: unknown }[] }
    ).clients;
    expect(clients.find((c) => c.id === "oidc-codex")?.oidc).toMatchObject({
      issuerHost: "idp.example.test",
      claim: "sub",
    });
    expect(listed.human).toContain("idp.example.test");
    expect(listed.human).not.toContain(SUBJECT);
    expect(JSON.stringify(listed.value)).not.toContain(SUBJECT);

    await run(ws, ["oidc", "clear"]);
    expect((await run(ws, ["oidc", "show"])).value).toEqual({
      configured: false,
    });
  });

  test("a mapping without OIDC configured is refused, and bad usage is named", async () => {
    const ws = await workspace();
    const tokenFile = join(ws.dir, "x.token");
    await expect(
      run(ws, ["client", "add", "oidc-codex"], {
        name: "X",
        scopes: "status:read",
        hosts: "agent-host",
        "token-file": tokenFile,
        "oidc-subject": SUBJECT,
      }),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("Configure OIDC first"),
    });
    await expect(
      run(ws, ["oidc", "set"], { issuer: "https://idp.example.test" }),
    ).rejects.toMatchObject({
      code: 2,
    });
    await expect(run(ws, ["oidc", "frob"])).rejects.toMatchObject({ code: 2 });
  });
});
