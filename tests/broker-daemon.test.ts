// End to end over the real transport (unix socket on POSIX, loopback TCP on
// Windows): migrate, start the daemon, create an agent client as the owner,
// run a safe command, and get a risky one approved by the owner.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths } from "../src/broker/paths";
import { MARKER_FILE } from "../src/migrate";

let dir: string;
let stop: (() => Promise<void>) | undefined;
const PASSWORD = "owner password for tests";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-daemon-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("agent and owner flows through the running daemon", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  const paths = compatPaths(inventoryPath);
  const ran: string[][] = [];
  const daemon = await startDaemon({
    mode: "compat",
    ...paths,
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    panelOrigin: "http://127.0.0.1:7448",
    executor: {
      run: async ({ argv }) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "fine", stderr: "" };
      },
    },
  });
  stop = daemon.stop;
  // Automatic migration marked the workspace.
  expect(
    JSON.parse(await readFile(join(dir, MARKER_FILE), "utf8")).data_version,
  ).toBe(3);
  await daemon.verifier.set(PASSWORD);
  const endpoint = daemon.endpoint;

  const { token: owner } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  const asOwner = { endpoint, authorization: `Owner ${owner}` };
  await expect(
    callBroker(
      "/v1/owner/clients/create",
      { id: "codex-pc", name: "Codex", hosts: ["pc"] },
      asOwner,
    ),
  ).rejects.toThrow("owner password");
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    asOwner,
  );
  const asAgent = { endpoint, authorization: `Bearer ${created.token}` };

  const safe = await callBroker<{ state: string; result: { stdout: string } }>(
    "/v1/exec",
    { host: "pc", argv: ["hostname"], waitMs: 5000 },
    asAgent,
  );
  expect(safe.state).toBe("succeeded");
  expect(safe.result.stdout).toBe("fine");

  const risky = await callBroker<{
    id: string;
    fingerprint: string;
    state: string;
    approvalSurface: string;
  }>(
    "/v1/exec",
    { host: "pc", argv: ["systemctl", "--user", "restart", "x"] },
    asAgent,
  );
  expect(risky.state).toBe("awaiting-approval");
  expect(risky.approvalSurface).toContain("127.0.0.1:7448");
  // The agent's token cannot decide.
  await expect(
    callBroker(
      "/v1/owner/decide",
      {
        operationId: risky.id,
        fingerprint: risky.fingerprint,
        decision: "approve-once",
      },
      { endpoint, authorization: `Owner ${created.token}` },
    ),
  ).rejects.toThrow();
  await callBroker(
    "/v1/owner/decide",
    {
      operationId: risky.id,
      fingerprint: risky.fingerprint,
      decision: "approve-once",
      password: PASSWORD,
    },
    asOwner,
  );
  const done = await callBroker<{ state: string }>(
    "/v1/wait",
    { id: risky.id, timeoutMs: 5000 },
    asAgent,
  );
  expect(done.state).toBe("succeeded");
  expect(ran.length).toBe(2);

  // Revocation takes effect on the next request.
  await callBroker("/v1/owner/clients/revoke", { id: "codex-pc" }, asOwner);
  await expect(callBroker("/v1/whoami", {}, asAgent)).rejects.toThrow(
    "Client token required",
  );
});
