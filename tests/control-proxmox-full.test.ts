import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import type { ApiFetch } from "../src/proxmox/api";
import { runProxmoxApi } from "../src/proxmox/api";

// Full-mode Proxmox operations through the control plane. Synthetic host and
// addresses only; the API fetcher is a fake, so nothing is contacted.
const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const TOKEN = "PVEAPIToken=ops@pve!homectl=SECRET-VALUE-123";
const UPID = "UPID:pve-test:0001:0002:0003:qmstart:9003:ops@pve!homectl:";

function inventory(
  caFile: string,
  operations?: string,
  address = "192.0.2.10",
) {
  return `version: 1
session:
  ttl: 1h
  database: /tmp/homectl-synthetic/vault.kdbx
machines:
  pve-host:
    description: Synthetic Proxmox host
    transport: ssh
    access: full
    ssh_alias: pve-host
    address: ${address}
    user: ops
    auth:
      type: keepassxc
      entry: homectl-pve-host
      socket: /tmp/homectl-synthetic/agent.sock
      public_key: /tmp/homectl-synthetic/pve-host.pub
providers:
  pve-test:
    type: proxmox
    host: pve-host
    node: pve-test
    vmid_range: [9001, 9010]
    protected_vmids: [9009]
    storages: [local-test]
${operations === undefined ? "" : `    operations: ${operations}\n`}    api:
      url: https://pve.example:8006
      ca_file: ${caFile}
      token_entry: homectl-pve-token
`;
}

type Recorded = { url: string; init: RequestInit & { tls?: { ca: string } } };

// Fake API: reads return a config with a secret field, changes return a task.
function fakeFetch(calls: Recorded[]): ApiFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const method = String(init.method);
    let data: unknown = { status: 500 };
    if (method === "GET" && path.endsWith("/config"))
      data = { memory: 2048, cipassword: "hunter2", name: "sample-vm" };
    else if (method === "POST") data = UPID;
    else if (method === "PUT") data = null;
    else if (path.includes("/tasks/"))
      data = { status: "stopped", exitstatus: "OK" };
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture(operations?: string) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-pve-full-"));
  dirs.push(dir);
  const caFile = join(dir, "pve-root-ca.pem");
  await writeFile(caFile, PEM);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, inventory(caFile, operations));
  const calls: Recorded[] = [];
  const sshRuns: unknown[] = [];
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner: async (spec) => {
      sshRuns.push(spec);
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
    proxmoxApi: {
      fetcher: fakeFetch(calls),
      sleep: async () => undefined,
      pollMs: 0,
      tokenSource: async (name) =>
        name === "pve-api-pve-test" ? TOKEN : undefined,
    },
  });
  await plane.init();
  const codexToken = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read", "status:read"],
    hosts: ["pve-host"],
  });
  const hermesToken = await plane.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["approve:decide", "status:read"],
    hosts: ["pve-host"],
  });
  const codex = (await plane.authenticate(
    codexToken.token as string,
  )) as ClientIdentity;
  const hermes = (await plane.authenticate(
    hermesToken.token as string,
  )) as ClientIdentity;
  return { plane, codex, hermes, calls, sshRuns, inventoryPath, caFile };
}

type F = Awaited<ReturnType<typeof fixture>>;

function plan(f: F, fields: Record<string, unknown>) {
  return f.plane.request(
    { kind: "client", client: f.codex },
    { op: "proxmox-api", host: "pve-host", ...fields },
  ) as Promise<{
    operationId: string;
    fingerprint: string;
    impact: string;
    classification: string;
    needsApproval: boolean;
    ownerOnly?: boolean;
    risk?: string;
    state: string;
  }>;
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no refusal";
}

function approve(f: F, op: { operationId: string; fingerprint: string }) {
  return f.plane.request(
    { kind: "client", client: f.hermes },
    {
      op: "approve",
      operationId: op.operationId,
      fingerprint: op.fingerprint,
      decision: "approve",
    },
  );
}

function execute(f: F, operationId: string) {
  return f.plane.request(
    { kind: "local-operator" },
    { op: "execute", operationId },
  ) as Promise<{
    operation: { state: string };
    output?: { stdout: string; stderr: string };
  }>;
}

describe("full-mode Proxmox operations through the control plane", () => {
  test("guest mode is the default and refuses full operations, naming the setting", async () => {
    const f = await fixture();
    const message = await errorMessage(
      plan(f, { method: "GET", path: "/nodes/pve-test/qemu/9003/config" }),
    );
    expect(message).toContain("operations: full");
  });

  test("a read is planned as inspection, runs without approval, and its secrets are redacted", async () => {
    const f = await fixture("full");
    const op = await plan(f, {
      method: "GET",
      path: "/nodes/pve-test/qemu/9003/config",
    });
    expect(op.classification).toBe("inspect");
    expect(op.needsApproval).toBe(false);
    const ran = await execute(f, op.operationId);
    expect(ran.operation.state).toBe("succeeded");
    expect(ran.output?.stdout).toContain("[REDACTED]");
    expect(ran.output?.stdout).not.toContain("hunter2");
    const read = f.calls.find((c) => c.init.method === "GET");
    expect(new URL(read?.url ?? "").pathname).toBe(
      "/api2/json/nodes/pve-test/qemu/9003/config",
    );
    expect(f.sshRuns).toHaveLength(0);
  });

  test("a change needs approval, then runs over the API with the approved request", async () => {
    const f = await fixture("full");
    const op = await plan(f, {
      method: "POST",
      path: "/nodes/pve-test/qemu/9003/status/start",
    });
    expect(op.needsApproval).toBe(true);
    expect(op.impact).toBe("Start VM 9003");
    expect(op.risk).toBe("R2");
    await approve(f, op);
    const ran = await execute(f, op.operationId);
    expect(ran.operation.state).toBe("succeeded");
    const post = f.calls.find((c) => c.init.method === "POST");
    expect(new URL(post?.url ?? "").pathname).toBe(
      "/api2/json/nodes/pve-test/qemu/9003/status/start",
    );
    expect(f.sshRuns).toHaveLength(0);
  });

  test("owner-only operations are planned and shown, but no client can approve them", async () => {
    const f = await fixture("full");
    const op = await plan(f, { method: "GET", path: "/access/users" });
    expect(op.ownerOnly).toBe(true);
    expect(op.classification).toBe("destructive");
    expect(await errorMessage(approve(f, op))).toContain("owner-only");
    const view = (await f.plane.listOperations({ all: true })).find(
      (o) => o.operationId === op.operationId,
    );
    expect(view?.state).toBe("pending");
  });

  test("protected VMIDs cannot be destroyed, and vmid_range still applies", async () => {
    const f = await fixture("full");
    expect(
      await errorMessage(
        plan(f, { method: "DELETE", path: "/nodes/pve-test/qemu/9009" }),
      ),
    ).toContain("protected_vmids");
    expect(
      await errorMessage(
        plan(f, {
          method: "POST",
          path: "/nodes/pve-test/qemu/9011/status/start",
        }),
      ),
    ).toContain("outside the provider's vmid_range");
  });

  test("secret-looking parameters are refused and never stored", async () => {
    const f = await fixture("full");
    const message = await errorMessage(
      plan(f, {
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: { cipassword: "hunter2" },
      }),
    );
    expect(message).toContain("looks like a secret");
    expect(message).not.toContain("hunter2");
    const stored = JSON.stringify(await f.plane.listOperations({ all: true }));
    expect(stored).not.toContain("hunter2");
  });

  test("a machine change after approval stops the operation before it runs", async () => {
    const f = await fixture("full");
    const op = await plan(f, {
      method: "POST",
      path: "/nodes/pve-test/qemu/9003/status/start",
    });
    await approve(f, op);
    await writeFile(f.inventoryPath, inventory(f.caFile, "full", "192.0.2.11"));
    expect(await errorMessage(execute(f, op.operationId))).toContain(
      "Machine or command changed since approval",
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe("full-mode transport helper", () => {
  test("a full-mode request over the transport sends the validated parameters only", async () => {
    const calls: Recorded[] = [];
    const result = await runProxmoxApi(
      { baseUrl: "https://pve.example:8006", caPem: PEM, authorization: TOKEN },
      "pve-test",
      {
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: { memory: "4096" },
        task: false,
        inspect: false,
      },
      { fetcher: fakeFetch(calls), sleep: async () => undefined },
    );
    expect(result.exitCode).toBe(0);
    const put = calls[0];
    expect(put?.init.method).toBe("PUT");
    expect(String(put?.init.body)).toBe("memory=4096");
  });
});
