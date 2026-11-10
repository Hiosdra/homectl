import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import {
  type ApiFetch,
  apiRequestFor,
  runProxmoxApi,
} from "../src/proxmox/api";
import type { ProxmoxFacts, ProxmoxInput } from "../src/proxmox/catalogue";
import { HomectlError, type ProcessSpec } from "../src/types";

setDefaultTimeout(60_000);

const facts: ProxmoxFacts = {
  host: "pve-host",
  node: "pve-test",
  vmidMin: 9001,
  vmidMax: 9010,
  vmidRangeSet: true,
  protectedVmids: [9009],
  storages: ["local-test"],
  templates: ["debian-12-standard_12.2-1_amd64.tar.zst"],
};
const TOKEN = "PVEAPIToken=ops@pve!homectl=SECRET-VALUE-123";
const PEM =
  "-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----\n";
const UPID = "UPID:pve-test:0001:0002:0003:qmstart:9003:ops@pve!homectl:";

describe("request mapping: each catalogue action becomes one exact API call", () => {
  test("reads are GET and inspect only", () => {
    expect(apiRequestFor({ kind: "qemu", action: "list" }, facts)).toEqual({
      method: "GET",
      path: "/nodes/pve-test/qemu",
      params: {},
      task: false,
      inspect: true,
    });
    expect(
      apiRequestFor({ kind: "lxc", action: "status", vmid: 9004 }, facts),
    ).toMatchObject({
      method: "GET",
      path: "/nodes/pve-test/lxc/9004/status/current",
      inspect: true,
    });
    expect(
      apiRequestFor({ kind: "qemu", action: "config", vmid: 9003 }, facts),
    ).toMatchObject({
      method: "GET",
      path: "/nodes/pve-test/qemu/9003/config",
    });
  });

  test("power actions are POST tasks on the status path", () => {
    for (const action of ["start", "stop", "reboot"] as const)
      expect(
        apiRequestFor({ kind: "qemu", action, vmid: 9003 }, facts),
      ).toMatchObject({
        method: "POST",
        path: `/nodes/pve-test/qemu/9003/status/${action}`,
        task: true,
        inspect: false,
      });
    expect(
      apiRequestFor({ kind: "lxc", action: "shutdown", vmid: 9004 }, facts),
    ).toMatchObject({
      method: "POST",
      path: "/nodes/pve-test/lxc/9004/status/shutdown",
      params: { timeout: "120" },
    });
  });

  test("clone and create carry the same values as the approved argv", () => {
    expect(
      apiRequestFor(
        {
          kind: "qemu",
          action: "clone",
          vmid: 9002,
          template: 9001,
          name: "sample-clone",
          storage: "local-test",
        },
        facts,
      ),
    ).toEqual({
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/clone",
      params: {
        newid: "9002",
        name: "sample-clone",
        full: "1",
        storage: "local-test",
      },
      task: true,
      inspect: false,
    });
    const create: ProxmoxInput = {
      kind: "lxc",
      action: "create",
      vmid: 9005,
      name: "sample-ct",
      template: "debian-12-standard_12.2-1_amd64.tar.zst",
      storage: "local-test",
      memory_mb: 512,
      cores: 1,
      disk_gb: 4,
      bridge: "vmbr0",
      address: "dhcp",
    };
    expect(apiRequestFor(create, facts).params).toEqual({
      vmid: "9005",
      ostemplate: "local-test:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst",
      hostname: "sample-ct",
      unprivileged: "1",
      memory: "512",
      cores: "1",
      rootfs: "local-test:4",
      net0: "name=eth0,bridge=vmbr0,ip=dhcp",
    });
  });

  test("destroy purges and names the guest by VMID", () => {
    expect(
      apiRequestFor(
        { kind: "qemu", action: "destroy", vmid: 9002, name: "x" },
        facts,
      ),
    ).toMatchObject({
      method: "DELETE",
      path: "/nodes/pve-test/qemu/9002",
      params: { purge: "1" },
      task: true,
    });
  });

  test("the same refusals as the SSH path apply, for example a protected VMID", () => {
    expect(() =>
      apiRequestFor(
        { kind: "qemu", action: "destroy", vmid: 9009, name: "x" },
        facts,
      ),
    ).toThrow(HomectlError);
    expect(() =>
      apiRequestFor({ kind: "qemu", action: "start", vmid: 9999 }, facts),
    ).toThrow(HomectlError);
  });
});

function fakeFetch(
  calls: Array<{ url: string; init: RequestInit & { tls?: { ca: string } } }>,
  route: (method: string, path: string) => { status: number; data?: unknown },
): ApiFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const reply = route(String(init.method), new URL(url).pathname);
    return new Response(JSON.stringify({ data: reply.data }), {
      status: reply.status,
    });
  };
}

describe("runProxmoxApi", () => {
  test("sends the token and the CA over TLS, and never echoes the token", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit & { tls?: { ca: string } };
    }> = [];
    const result = await runProxmoxApi(
      { baseUrl: "https://pve.example:8006", caPem: PEM, authorization: TOKEN },
      "pve-test",
      apiRequestFor({ kind: "qemu", action: "list" }, facts),
      {
        fetcher: fakeFetch(calls, () => ({
          status: 200,
          data: [{ vmid: 9001 }],
        })),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ vmid: 9001 }]);
    expect(calls[0]?.url).toBe(
      "https://pve.example:8006/api2/json/nodes/pve-test/qemu",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(calls[0]?.init.tls?.ca).toBe(PEM);
    expect(calls[0]?.init.redirect).toBe("error");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "SECRET-VALUE-123",
    );
  });

  test("a task is polled until it stops, and OK means exit 0", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit & { tls?: { ca: string } };
    }> = [];
    let polls = 0;
    const result = await runProxmoxApi(
      { baseUrl: "https://pve.example:8006", caPem: PEM, authorization: TOKEN },
      "pve-test",
      apiRequestFor({ kind: "qemu", action: "start", vmid: 9003 }, facts),
      {
        fetcher: fakeFetch(calls, (method, path) => {
          if (method === "POST") return { status: 200, data: UPID };
          if (path.includes("/tasks/")) {
            polls += 1;
            return polls < 2
              ? { status: 200, data: { status: "running" } }
              : { status: 200, data: { status: "stopped", exitstatus: "OK" } };
          }
          return { status: 500 };
        }),
        sleep: async () => undefined,
        pollMs: 0,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(polls).toBe(2);
    expect(calls[0]?.init.body).toBe("");
  });

  test("a task that ends with an error is exit 1 with a short reason", async () => {
    const result = await runProxmoxApi(
      { baseUrl: "https://pve.example:8006", caPem: PEM, authorization: TOKEN },
      "pve-test",
      apiRequestFor({ kind: "qemu", action: "stop", vmid: 9003 }, facts),
      {
        fetcher: fakeFetch([], (method, path) =>
          method === "POST"
            ? { status: 200, data: UPID }
            : path.includes("/tasks/")
              ? {
                  status: 200,
                  data: { status: "stopped", exitstatus: "VM is locked" },
                }
              : { status: 500 },
        ),
        sleep: async () => undefined,
        pollMs: 0,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Task ended: VM is locked");
  });

  test("an HTTP refusal is exit 1 and carries no body or token", async () => {
    const result = await runProxmoxApi(
      { baseUrl: "https://pve.example:8006", caPem: PEM, authorization: TOKEN },
      "pve-test",
      apiRequestFor({ kind: "qemu", action: "config", vmid: 9003 }, facts),
      { fetcher: fakeFetch([], () => ({ status: 403 })) },
    );
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Proxmox API returned HTTP 403",
    });
  });

  test("a task still running at the budget throws, which the engine records as unknown", async () => {
    await expect(
      runProxmoxApi(
        {
          baseUrl: "https://pve.example:8006",
          caPem: PEM,
          authorization: TOKEN,
        },
        "pve-test",
        apiRequestFor({ kind: "qemu", action: "reboot", vmid: 9003 }, facts),
        {
          fetcher: fakeFetch([], (method, path) =>
            method === "POST"
              ? { status: 200, data: UPID }
              : path.includes("/tasks/")
                ? { status: 200, data: { status: "running" } }
                : { status: 500 },
          ),
          sleep: async () => undefined,
          pollMs: 0,
          taskTimeoutMs: 0,
        },
      ),
    ).rejects.toThrow("did not finish");
  });
});

// The engine on the API transport: approval first, then execution through HTTPS.
const INVENTORY = (caFile: string) => `version: 1
session:
  ttl: 1h
  database: /tmp/homectl-synthetic/vault.kdbx
machines:
  pve-host:
    description: Synthetic Proxmox host
    transport: ssh
    access: full
    ssh_alias: pve-host
    address: 192.0.2.10
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
    api:
      url: https://pve.example:8006
      ca_file: ${caFile}
      token_entry: homectl-pve-token
`;

describe("control plane with the API transport", () => {
  async function fixture(tokenFor: (name: string) => string | undefined) {
    const dir = await mkdtemp(join(tmpdir(), "homectl-pve-api-"));
    const caFile = join(dir, "pve-root-ca.pem");
    await writeFile(caFile, PEM);
    const inventoryPath = join(dir, "inventory.yaml");
    await writeFile(inventoryPath, INVENTORY(caFile));
    const sshRuns: ProcessSpec[] = [];
    const calls: Array<{
      url: string;
      init: RequestInit & { tls?: { ca: string } };
    }> = [];
    const plane = new ControlPlane({
      inventoryPath,
      configPath: join(dir, "ssh_config"),
      stateDirectory: join(dir, "control-plane"),
      runner: async (spec) => {
        sshRuns.push(spec);
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      proxmoxApi: {
        fetcher: fakeFetch(calls, (method, path) => {
          if (method === "POST") return { status: 200, data: UPID };
          if (path.includes("/tasks/"))
            return {
              status: 200,
              data: { status: "stopped", exitstatus: "OK" },
            };
          return { status: 500 };
        }),
        sleep: async () => undefined,
        pollMs: 0,
        tokenSource: async (name) => tokenFor(name),
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
    const cleanup = () => rm(dir, { recursive: true, force: true });
    return { plane, codex, hermes, sshRuns, calls, cleanup };
  }

  async function planAndApprove(
    f: Awaited<ReturnType<typeof fixture>>,
    vmid: number,
  ): Promise<string> {
    const op = (await f.plane.request(
      { kind: "client", client: f.codex },
      {
        op: "proxmox-plan",
        host: "pve-host",
        kind: "qemu",
        action: "start",
        vmid,
      },
    )) as { operationId: string; fingerprint: string };
    await f.plane.request(
      { kind: "client", client: f.hermes },
      {
        op: "approve",
        operationId: op.operationId,
        fingerprint: op.fingerprint,
        decision: "approve",
      },
    );
    return op.operationId;
  }

  test("an approved start runs over HTTPS with the session token, not over SSH", async () => {
    const f = await fixture((name) =>
      name === "pve-api-pve-test" ? TOKEN : undefined,
    );
    try {
      const operationId = await planAndApprove(f, 9003);
      const ran = (await f.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId },
      )) as { operation: { state: string } };
      expect(ran.operation.state).toBe("succeeded");
      expect(f.sshRuns).toHaveLength(0);
      const post = f.calls.find((c) => c.init.method === "POST");
      expect(post?.url).toBe(
        "https://pve.example:8006/api2/json/nodes/pve-test/qemu/9003/status/start",
      );
      expect((post?.init.headers as Record<string, string>).Authorization).toBe(
        TOKEN,
      );
      // The token is never part of the operation view.
      const views = JSON.stringify(await f.plane.listOperations({ all: true }));
      expect(views).not.toContain("SECRET-VALUE-123");
    } finally {
      await f.cleanup();
    }
  });

  test("without the token the operation is refused, stays approved, and nothing is sent", async () => {
    const f = await fixture(() => undefined);
    try {
      const operationId = await planAndApprove(f, 9004);
      await expect(
        f.plane.request(
          { kind: "local-operator" },
          { op: "execute", operationId },
        ),
      ).rejects.toThrow("Unlock the session first");
      expect(f.calls).toHaveLength(0);
      expect(f.sshRuns).toHaveLength(0);
      const view = (await f.plane.listOperations({ all: true })).find(
        (o) => o.operationId === operationId,
      );
      expect(view?.state).toBe("approved");
    } finally {
      await f.cleanup();
    }
  });
});
