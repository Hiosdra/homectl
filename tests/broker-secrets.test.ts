// Secret request → owner provides → agent uses, over the running daemon.
// The agent must never see the value, even when the remote command echoes it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths } from "../src/broker/paths";
import { canaryLeaks } from "../src/secrets";

let dir: string;
let stop: (() => Promise<void>) | undefined;
const PASSWORD = "owner password for tests";
const SECRET = "s3cr3t-Canary-value-9f2c";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-secrets-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n  nas:\n    description: other\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("a secret reaches only its bound destination and never the agent", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  const received: { argv: string[]; stdin?: string }[] = [];
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async ({ argv, stdin }) => {
        received.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
        // A careless command that prints its input.
        return { exitCode: 0, stdout: `got ${stdin}`, stderr: "" };
      },
    },
  });
  stop = daemon.stop;
  await daemon.verifier.set(PASSWORD);
  const endpoint = daemon.endpoint;
  const { token: owner } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  const asOwner = { endpoint, authorization: `Owner ${owner}` };
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    asOwner,
  );
  const asAgent = { endpoint, authorization: `Bearer ${created.token}` };
  const destination = {
    kind: "ssh-stdin",
    host: "pc",
    argv: ["docker", "login", "--password-stdin"],
  };

  // Hosts outside the client's grant are refused like unknown ones.
  await expect(
    callBroker(
      "/v1/secret/request",
      {
        purpose: "x",
        destination: { ...destination, host: "nas" },
        fields: [{ name: "token" }],
      },
      asAgent,
    ),
  ).rejects.toThrow("not granted");

  const request = await callBroker<{ id: string; state: string }>(
    "/v1/secret/request",
    { purpose: "registry login", destination, fields: [{ name: "token" }] },
    asAgent,
  );
  expect(request.state).toBe("pending");
  const pending = await callBroker<{ id: string; purpose: unknown }[]>(
    "/v1/owner/secrets/pending",
    {},
    asOwner,
  );
  expect(pending.map((p) => p.id)).toEqual([request.id]);
  expect(pending[0]?.purpose).toEqual({ untrusted: "registry login" });

  // Agents cannot provide values to themselves.
  await expect(
    callBroker(
      "/v1/owner/secrets/provide",
      { id: request.id, values: { token: SECRET } },
      asAgent,
    ),
  ).rejects.toThrow();
  await callBroker(
    "/v1/owner/secrets/provide",
    { id: request.id, values: { token: SECRET }, retention: "ephemeral" },
    asOwner,
  );
  const status = await callBroker<{ state: string; ref: string }>(
    "/v1/secret/status",
    { id: request.id },
    asAgent,
  );
  expect(status.state).toBe("provided");

  // A different destination is refused.
  await expect(
    callBroker(
      "/v1/secret/use",
      {
        ref: status.ref,
        destination: { ...destination, argv: ["sh", "-c", "cat"] },
      },
      asAgent,
    ),
  ).rejects.toThrow();
  const used = await callBroker<Record<string, unknown>>(
    "/v1/secret/use",
    { ref: status.ref, destination },
    asAgent,
  );
  expect(received).toEqual([
    { argv: ["docker", "login", "--password-stdin"], stdin: SECRET },
  ]);
  expect(used.exitCode).toBe(0);
  const agentSaw = JSON.stringify([request, pending, status, used]);
  expect(canaryLeaks([agentSaw], [SECRET])).toEqual([]);
});
