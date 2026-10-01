#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { credentialSpec } from "../credentials";
import { provisioningFailureMessage } from "../diagnostics";
import { enroll, installSudo } from "../enroll";
import { loadInventory, resolveHost } from "../inventory";
import { execute, workerPath, writeSSHConfig } from "../operations";
import { checkApproval, planExecution } from "../policies";
import { run } from "../process";
import { type ProvisionRequest, planProvision } from "../provisioners";
import { doctor, installAAC, paths, setup } from "../setup";
import { transportSpec } from "../transports";
import { HomectlError, type Machine, type ProcessResult } from "../types";
export const help = `homectl — agent-managed homelab (Bun 1.4.2+)
  setup [--dry-run] [--install-bitwarden-cli] [--aac-version V --aac-sha256 HASH]
  doctor [host]                  inspect tools; classify SSH/AAC connectivity failures
  hosts | inspect <host>        inventory and purpose/access/cautions
  exec <host> [--impact TEXT] [--approval DIGEST] [--dry-run] -- command argv...
  ssh <host> -- command argv...  same guarded transport; no unguarded interactive shell
  enroll <host> --file host.json [--configure-sudo] [--dry-run]
  sudoers <host>                 print literal sudoers policy without installing
  provision --file vm.json [--dry-run]
Global: --inventory PATH, --json (put flags before command argv separator)
Exit: 0 success, 2 input/config, 3 policy/conflict, 4 exact confirmation needed,
      5 transport/provider/setup, 6 command failed (result includes remote exitCode).
No --yes flag. Approval DIGEST attests an exact user confirmation already received.
`;
export async function main(raw = process.argv.slice(2)): Promise<number> {
  const split = raw.indexOf("--");
  const cliArgs = split < 0 ? raw : raw.slice(0, split);
  const commandArgs = split < 0 ? [] : raw.slice(split + 1);
  let json = false;
  try {
    const { values: v, positionals } = parseArgs({
      args: cliArgs,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        inventory: { type: "string" },
        file: { type: "string" },
        approval: { type: "string" },
        impact: { type: "string" },
        "configure-sudo": { type: "boolean" },
        help: { type: "boolean" },
        "install-bitwarden-cli": { type: "boolean" },
        "aac-version": { type: "string" },
        "aac-sha256": { type: "string" },
      },
    });
    json = v.json ?? false;
    const [command, host] = positionals;
    const p = paths();
    const inventoryPath = v.inventory ? resolve(v.inventory) : p.inventory;
    const configPath = v.inventory ? `${inventoryPath}.ssh_config` : p.ssh;
    const dryRun = v["dry-run"] ?? false;
    const emit = (result: unknown) =>
      console.log(
        json
          ? JSON.stringify(result)
          : typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2),
      );
    if (!command || v.help || command === "help") {
      emit(help);
      return 0;
    }
    if (command === "setup") {
      if (v.inventory)
        throw new HomectlError(
          2,
          "setup uses the standard per-user directory; use --inventory on later commands",
        );
      const result = await setup(p.home, dryRun);
      if (!dryRun && v["install-bitwarden-cli"]) {
        const install = await run({
          argv: ["npm", "install", "--prefix", p.base, "@bitwarden/cli"],
          timeoutMs: 120_000,
        });
        if (install.exitCode !== 0)
          throw new HomectlError(5, "Bitwarden CLI installation failed");
        emit({
          installed: `${p.base}/node_modules/.bin/bw`,
          next: "Add this directory to PATH for aac listen",
        });
      }
      if (!dryRun && v["aac-version"])
        emit(await installAAC(v["aac-version"], v["aac-sha256"] ?? "", p.home));
      emit(result);
      return 0;
    }
    const inv = await loadInventory(inventoryPath);
    if (positionals.length > 2)
      throw new HomectlError(
        2,
        "Unexpected positional arguments; commands require the -- separator",
      );
    if (command === "hosts") {
      emit(inv.machines);
      return 0;
    }
    if (command === "inspect") {
      if (!host) throw new HomectlError(2, "Specify host");
      emit({ host, ...resolveHost(inv, host) });
      return 0;
    }
    if (command === "doctor") {
      if (dryRun) {
        emit({ wouldCheck: host ?? "tools", credentialFetch: false });
        return 0;
      }
      await writeSSHConfig(configPath, inv.machines);
      const result = await doctor(inv, configPath, host);
      emit(result);
      return result.ok ? 0 : 5;
    }
    if (command === "exec" || command === "ssh") {
      if (!host) throw new HomectlError(2, "Specify host");
      if (!dryRun) {
        checkApproval(
          planExecution(host, resolveHost(inv, host), commandArgs, v.impact),
          v.approval,
        );
        await writeSSHConfig(configPath, inv.machines);
      }
      const result = await execute(host, resolveHost(inv, host), commandArgs, {
        configPath,
        dryRun,
        approval: v.approval,
        impact: v.impact,
      });
      emit(result);
      return "result" in result && result.result && result.result.exitCode !== 0
        ? 6
        : 0;
    }
    if (command === "sudoers") {
      if (!host) throw new HomectlError(2, "Specify host");
      const m = resolveHost(inv, host);
      emit((await import("../policies")).sudoers(m.user ?? "", m));
      return 0;
    }
    if (command === "enroll") {
      if (!host || !v.file)
        throw new HomectlError(2, "enroll requires host and --file");
      const m = JSON.parse(await readFile(v.file, "utf8")) as Machine;
      emit(
        await enroll(host, m, inventoryPath, configPath, {
          dryRun,
          configureSudo: v["configure-sudo"],
        }),
      );
      return 0;
    }
    if (command === "provision") {
      if (!v.file) throw new HomectlError(2, "provision requires --file");
      const request = JSON.parse(
        await readFile(v.file, "utf8"),
      ) as ProvisionRequest;
      const provider = inv.providers?.[request.provider];
      if (!provider) throw new HomectlError(2, "Unknown provider");
      const plan = planProvision(request, provider.node);
      if (dryRun) {
        emit(plan);
        return 0;
      }
      if (
        inv.machines[request.name] &&
        JSON.stringify(inv.machines[request.name]) !==
          JSON.stringify(plan.machine)
      )
        throw new HomectlError(3, "Existing machine name conflicts with plan");
      const result = await run({
        argv: [
          "aac",
          "run",
          "--id",
          provider.auth.item_id ?? "",
          "--env",
          "HOMECTL_API_TOKEN=password",
          "--",
          process.execPath,
          workerPath,
          "proxmox",
        ],
        stdin: JSON.stringify({ config: provider, plan, stateDir: p.state }),
        timeoutMs: 2_700_000,
      });
      if (result.exitCode !== 0)
        throw new HomectlError(5, provisioningFailureMessage(result));
      await writeSSHConfig(configPath, {
        ...inv.machines,
        [request.name]: plan.machine,
      });
      let ready = false;
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const r = await run(
          credentialSpec(
            plan.machine.auth,
            transportSpec(plan.machine, ["uname", "-s"], configPath),
            workerPath,
          ),
        );
        if (r.exitCode === 0) {
          ready = true;
          break;
        }
        await Bun.sleep(2000);
      }
      if (!ready)
        throw new HomectlError(
          5,
          "VM created but SSH not ready; verify host fingerprint/network/key. Retry uses journal; no VM is deleted.",
        );
      const cloud = await run(
        credentialSpec(
          plan.machine.auth,
          transportSpec(
            plan.machine,
            ["cloud-init", "status", "--wait"],
            configPath,
          ),
          workerPath,
        ),
      );
      if (cloud.exitCode !== 0)
        throw new HomectlError(
          5,
          "Cloud-init did not complete successfully; inspect VM and retry",
        );
      if (
        ["full", "sudo-approved"].includes(request.access) &&
        plan.machine.user !== "root"
      )
        await installSudo(request.name, plan.machine, configPath);
      await enroll(request.name, plan.machine, inventoryPath, configPath);
      const privilege = plan.machine.user === "root" ? [] : ["sudo", "-n"];
      for (const software of request.packages ?? []) {
        const recipe =
          software === "docker"
            ? [...privilege, "apt-get", "install", "-y", "docker.io"]
            : [...privilege, "npm", "install", "-g", "bun@1.4.2"];
        await checked(
          await run(
            transportSpec(
              plan.machine,
              [...privilege, "apt-get", "update"],
              configPath,
            ),
          ),
        );
        if (software === "bun")
          await checked(
            await run(
              transportSpec(
                plan.machine,
                [...privilege, "apt-get", "install", "-y", "nodejs", "npm"],
                configPath,
              ),
            ),
          );
        await checked(
          await run(transportSpec(plan.machine, recipe, configPath)),
        );
        await checked(
          await run(
            transportSpec(
              plan.machine,
              software === "docker"
                ? [...privilege, "docker", "version"]
                : ["bun", "--version"],
              configPath,
            ),
          ),
        );
      }
      emit({
        vmid: request.vmid,
        host: request.name,
        enrolled: true,
        packages: request.packages ?? [],
      });
      return 0;
    }
    throw new HomectlError(2, "Unknown command; use homectl help");
  } catch (e) {
    const error =
      e instanceof HomectlError
        ? e
        : new HomectlError(
            2,
            "Invalid input or unavailable resource; details suppressed",
          );
    console.error(
      JSON.stringify({
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      }),
    );
    return error.code;
  }
}
async function checked(result: ProcessResult) {
  if (result.exitCode !== 0)
    throw new HomectlError(
      5,
      "Post-provision recipe failed; inspect machine package state before retrying",
    );
}
if (import.meta.main) process.exitCode = await main();
