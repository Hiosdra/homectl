import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { fileRestoreTarget } from "../src/workspace/restore-files";

const PASSWORD = "disposable workspace owner password";
const EMPTY = "version: 1\nmachines: {}\n";
const INVENTORY =
  "version: 1\nmachines:\n  fixture:\n    description: Restored fixture\n    transport: local\n    access: observe\n";
const stops: (() => Promise<void>)[] = [];
const directories: string[] = [];
setDefaultTimeout(30_000);

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixtureDirectory() {
  const dir = await mkdtemp(join(tmpdir(), "hc-workspace-restore-"));
  directories.push(dir);
  return dir;
}

async function device(contents: string, serverPort?: number) {
  const dir = await fixtureDirectory();
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, contents);
  const paths = compatPaths(inventoryPath);
  const daemon = await startDaemon({
    ...paths,
    mode: "compat",
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    ...(serverPort === undefined
      ? {}
      : {
          workspace: {
            server: { listen: { hostname: "127.0.0.1", port: serverPort } },
          },
        }),
  });
  stops.push(daemon.stop);
  await new FileVerifier(join(paths.state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);
  const endpoint = daemon.endpoint;
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  return {
    inventoryPath,
    owner: <T>(route: string, payload: Record<string, unknown> = {}) =>
      callBroker<T>(
        `/v1/owner/workspace/${route}`,
        { ...payload, password: PASSWORD },
        { endpoint, authorization: `Owner ${token}` },
      ),
  };
}

test("a real reset broker restores over the workspace listener with an empty bootstrap inventory", async () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("No workspace port");
  const address = `http://127.0.0.1:${port}`;
  const server = await device(EMPTY, port);
  const source = await device(INVENTORY);
  const reset = await device(EMPTY);
  const { code } = await server.owner<{ code: string }>("invite");
  await source.owner("join", { address, code, remoteApproval: false });
  const backedUp = await source.owner<{
    clientId: string;
    run: { seq: number };
  }>("backup-now");
  expect(backedUp.run.seq).toBe(1);
  const sourceDetails = {
    client: backedUp.clientId,
    seq: 1,
    reason: "Disposable release fixture restore",
  };
  const preview = await server.owner<{ verified: boolean }>(
    "restore-preview",
    sourceDetails,
  );
  expect(preview.verified).toBe(true);
  const restore = await server.owner<{ code: string }>(
    "restore",
    sourceDetails,
  );
  const joined = await reset.owner<{ restore: unknown }>("join", {
    address,
    code: restore.code,
    remoteApproval: false,
  });
  expect(joined.restore).toMatchObject({
    status: "restored",
    acknowledged: true,
    files: ["inventory.yaml"],
  });
  expect(await readFile(reset.inventoryPath, "utf8")).toBe(INVENTORY);
  const linked = await reset.owner<{ clientId: string }>("status");
  expect(linked.clientId).not.toBe(backedUp.clientId);
  await expect(source.owner("sync-now")).rejects.toThrow(
    "workspace server refused the request",
  );
});

test("real restore refuses a populated inventory and preserves its bytes", async () => {
  const dir = await fixtureDirectory();
  const inventoryPath = join(dir, "inventory.yaml");
  const state = join(dir, "broker");
  await mkdir(state);
  await writeFile(inventoryPath, INVENTORY);
  const target = fileRestoreTarget(inventoryPath, state);
  expect(await target.existing()).toEqual(["inventory.yaml"]);
  await expect(
    target.write([
      { path: "inventory.yaml", data: new TextEncoder().encode(EMPTY) },
    ]),
  ).rejects.toThrow("Refusing to overwrite");
  expect(await readFile(inventoryPath, "utf8")).toBe(INVENTORY);
});
