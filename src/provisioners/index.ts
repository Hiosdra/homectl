import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Access, HomectlError, type Machine } from "../types";
export interface ProvisionRequest {
  provider: string;
  vmid: number;
  template: number;
  name: string;
  cpus: number;
  memory_mb: number;
  disk_gb: number;
  disk?: string;
  address: string;
  cidr: number;
  gateway: string;
  bridge: string;
  user: string;
  public_key: string;
  access: Access;
  sudo_allow?: string[][];
  packages?: ("docker" | "bun")[];
}
export interface Step {
  id: string;
  method: "POST" | "PUT";
  path: string;
  params: Record<string, string | number>;
}
export interface ProvisionPlan {
  request: ProvisionRequest;
  fingerprint: string;
  steps: Step[];
  machine: Machine;
}
export interface API {
  request(
    method: string,
    path: string,
    params?: Record<string, string | number>,
  ): Promise<unknown>;
  wait(task: string): Promise<void>;
}
export interface Provisioner {
  plan(input: ProvisionRequest, node: string): ProvisionPlan;
  apply(plan: ProvisionPlan, api: API, stateDir: string): Promise<void>;
}
export function planProvision(
  r: ProvisionRequest,
  node: string,
): ProvisionPlan {
  const allowed = new Set([
    "provider",
    "vmid",
    "template",
    "name",
    "cpus",
    "memory_mb",
    "disk_gb",
    "disk",
    "address",
    "cidr",
    "gateway",
    "bridge",
    "user",
    "public_key",
    "access",
    "sudo_allow",
    "packages",
  ]);
  if (
    !r ||
    typeof r !== "object" ||
    Object.keys(r).some((k) => !allowed.has(k))
  )
    throw new HomectlError(
      2,
      "Invalid provisioning fields; secret values are forbidden",
    );
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(r.name) ||
    !/^[a-zA-Z0-9-]+$/.test(node) ||
    !/^[a-z][a-z0-9-]*$/.test(r.provider) ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(r.user)
  )
    throw new HomectlError(
      2,
      "Invalid provider, node, hostname or existing template user",
    );
  for (const [v, min, max] of [
    [r.vmid, 100, 999999999],
    [r.template, 100, 999999999],
    [r.cpus, 1, 256],
    [r.memory_mb, 128, 1048576],
    [r.disk_gb, 1, 65536],
    [r.cidr, 1, 32],
  ] as [number, number, number][])
    if (!Number.isInteger(v) || v < min || v > max)
      throw new HomectlError(2, "Invalid numeric VM configuration");
  if (r.vmid === r.template)
    throw new HomectlError(2, "VMID must differ from template");
  const ipv4 = (v: string) =>
    /^(\d{1,3}\.){3}\d{1,3}$/.test(v) &&
    v.split(".").every((n) => Number(n) <= 255);
  if (
    !ipv4(r.address) ||
    !ipv4(r.gateway) ||
    !/^[a-zA-Z0-9_-]+$/.test(r.bridge) ||
    !/^scsi[0-9]+$/.test(r.disk ?? "scsi0")
  )
    throw new HomectlError(
      2,
      "Use explicit IPv4 networking, valid bridge and scsi disk",
    );
  if (
    !/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/.test(r.public_key) ||
    /PRIVATE KEY/.test(r.public_key)
  )
    throw new HomectlError(
      2,
      "A public SSH key is required; private keys are forbidden",
    );
  if (
    !["observe", "user", "sudo-approved", "full"].includes(r.access) ||
    (r.user === "root" && r.access !== "full")
  )
    throw new HomectlError(2, "Invalid access tier or root template user");
  if (r.access === "sudo-approved" && !r.sudo_allow?.length)
    throw new HomectlError(2, "sudo-approved requires sudo_allow");
  if (r.packages?.some((p) => !["docker", "bun"].includes(p)))
    throw new HomectlError(
      2,
      "Only docker and bun post-provision recipes are supported",
    );
  if (r.packages?.length && r.access !== "full")
    throw new HomectlError(2, "Package recipes require full tier");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(r))
    .digest("hex");
  const base = `/nodes/${node}/qemu/${r.vmid}`;
  return {
    request: r,
    fingerprint,
    machine: {
      description: `Proxmox VM ${r.name} (${r.vmid})`,
      transport: "ssh",
      ssh_alias: r.name,
      address: r.address,
      user: r.user,
      access: r.access,
      enforcement:
        r.access === "full" || r.access === "sudo-approved"
          ? "sudoers"
          : "advisory",
      auth: { type: "local-ssh-agent" },
      ...(r.sudo_allow ? { sudo_allow: r.sudo_allow } : {}),
    },
    steps: [
      {
        id: "clone",
        method: "POST",
        path: `/nodes/${node}/qemu/${r.template}/clone`,
        params: {
          newid: r.vmid,
          name: r.name,
          full: 1,
          description: `homectl:${fingerprint}`,
        },
      },
      {
        id: "configure",
        method: "PUT",
        path: `${base}/config`,
        params: {
          cores: r.cpus,
          memory: r.memory_mb,
          ciuser: r.user,
          sshkeys: r.public_key,
          ipconfig0: `ip=${r.address}/${r.cidr},gw=${r.gateway}`,
          net0: `virtio,bridge=${r.bridge}`,
          agent: 1,
        },
      },
      {
        id: "resize",
        method: "PUT",
        path: `${base}/resize`,
        params: { disk: r.disk ?? "scsi0", size: `${r.disk_gb}G` },
      },
      { id: "boot", method: "POST", path: `${base}/status/start`, params: {} },
    ],
  };
}
interface Journal {
  fingerprint: string;
  complete: string[];
  pending?: { step: string; task: string };
  cloneStarted?: boolean;
}
export const proxmox: Provisioner = {
  plan: planProvision,
  async apply(plan, api, stateDir) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = join(
      stateDir,
      `${plan.request.provider}-${plan.request.vmid}.json`,
    );
    let state: Journal = { fingerprint: plan.fingerprint, complete: [] };
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new HomectlError(2, "Invalid provisioning journal");
    }
    if (state.fingerprint !== plan.fingerprint)
      throw new HomectlError(
        3,
        "VMID already has a different provisioning plan; reconcile manually",
      );
    const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
    const base = plan.steps[1]?.path;
    if (!base) throw new HomectlError(2, "Invalid plan");
    const list = (await api.request(
      "GET",
      base.replace(/\/\d+\/config$/, ""),
    )) as { vmid: number }[];
    const exists = list.some((v) => v.vmid === plan.request.vmid);
    if (exists) {
      const cfg = (await api.request("GET", base)) as {
        description?: string;
        name?: string;
      };
      if (
        cfg.description !== `homectl:${plan.fingerprint}` ||
        cfg.name !== plan.request.name
      )
        throw new HomectlError(
          3,
          "VMID collision: refusing to alter an unowned VM",
        );
    } else if (state.complete.length || state.pending || state.cloneStarted)
      throw new HomectlError(
        3,
        "Journal/VM mismatch; reconcile failed clone manually; no automatic replacement",
      );
    if (state.pending) {
      await api.wait(state.pending.task);
      state.complete.push(state.pending.step);
      delete state.pending;
      await save();
    }
    for (const step of plan.steps) {
      if (state.complete.includes(step.id)) continue;
      if (step.id === "clone" && exists) {
        state.complete.push(step.id);
        await save();
        continue;
      }
      if (step.id === "clone" && state.cloneStarted)
        throw new HomectlError(
          3,
          "Clone status uncertain; inspect Proxmox tasks before retrying",
        );
      if (step.id === "clone") {
        state.cloneStarted = true;
        await save();
      }
      const task = await api.request(step.method, step.path, step.params);
      if (typeof task === "string" && task.startsWith("UPID:")) {
        state.pending = { step: step.id, task };
        await save();
        await api.wait(task);
        delete state.pending;
      }
      state.complete.push(step.id);
      await save();
    }
  },
};
