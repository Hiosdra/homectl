import { dirname, join } from "node:path";
import { credentialSpec } from "../credentials";
import { workerArgv } from "../operations";
import { run } from "../process";
import {
  buildProxmoxPlan,
  type ProxmoxInput,
  providerFacts,
} from "../proxmox/catalogue";
import { trustedHostProbeSpec } from "../transports";
import {
  HomectlError,
  type Machine,
  type ProviderConfig,
  type Runner,
} from "../types";

export function proxmoxSsh(
  inventoryPath: string,
  machine: Machine,
  runner: Runner = run,
) {
  if (
    machine.access !== "full" ||
    machine.transport !== "ssh" ||
    machine.auth?.type !== "keepassxc"
  )
    throw new HomectlError(
      3,
      "The Proxmox catalogue needs a full-access SSH host with a managed key",
    );
  const knownHosts = join(dirname(inventoryPath), "known_hosts");
  return (argv: string[], timeoutMs = 10_000) =>
    runner(
      credentialSpec(
        machine.auth,
        {
          ...trustedHostProbeSpec(
            machine,
            [...(machine.user === "root" ? [] : ["sudo", "-n"]), ...argv],
            knownHosts,
          ),
          timeoutMs,
        },
        workerArgv,
      ),
    );
}

export async function readProxmoxSsh(
  call: ReturnType<typeof proxmoxSsh>,
  path: string,
  params: string[] = [],
): Promise<unknown> {
  const result = await call([
    "pvesh",
    "--noproxy",
    "get",
    path,
    "--output-format",
    "json",
    ...params,
  ]);
  if (result.exitCode === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      // An invalid result cannot prove a precondition.
    }
  }
  return undefined;
}

export async function localProxmoxNode(call: ReturnType<typeof proxmoxSsh>) {
  const nodes = await readProxmoxSsh(call, "/cluster/status");
  const local = Array.isArray(nodes)
    ? nodes.filter((entry) => entry?.type === "node" && entry.local === 1)
    : [];
  const name: unknown = local.length === 1 ? local[0]?.name : undefined;
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name))
    throw new HomectlError(
      3,
      "Could not identify the local Proxmox node over SSH",
    );
  return name;
}

export async function runProxmoxCatalogue(
  inventoryPath: string,
  machine: Machine,
  provider: ProviderConfig,
  catalogue: ProxmoxInput,
  approvedArgv: string[],
  beforeCommand: () => Promise<void>,
  runner: Runner = run,
) {
  const { argv } = buildProxmoxPlan(catalogue, providerFacts(provider));
  if (
    argv.length !== approvedArgv.length ||
    argv.some((argument, index) => argument !== approvedArgv[index])
  )
    throw new HomectlError(3, "The Proxmox command changed since approval");
  const call = proxmoxSsh(inventoryPath, machine, runner);
  if ((await localProxmoxNode(call)) !== provider.node)
    throw new HomectlError(
      3,
      "Could not confirm the configured Proxmox node over SSH",
    );

  if (catalogue.action === "create" || catalogue.action === "clone") {
    const vmid = String(catalogue.vmid);
    if (
      (await readProxmoxSsh(call, "/cluster/nextid", ["--vmid", vmid])) !==
      catalogue.vmid
    )
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Proxmox did not confirm VMID ${vmid} is free. No guest command was sent.`,
      };
  }

  // Proxmox also checks and claims the guest ID during create. The catalogue
  // never sends an overwrite, force or skiplock flag.
  await beforeCommand();
  const result = await call(argv, 120_000);
  if ([124, 137, 143, 255, -1].includes(result.exitCode))
    throw new Error("SSH interrupted while running the Proxmox guest command");
  return result;
}
