#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { credentialSpec } from "../credentials";
import { enroll, installSudo } from "../enroll";
import { loadInventory, resolveHost, saveInventory } from "../inventory";
import { execute, workerPath, writeSSHConfig } from "../operations";
import { checkApproval, planExecution } from "../policies";
import { run } from "../process";
import { type ProvisionRequest, planProvision, proxmox } from "../provisioners";
import { proxmoxSSH } from "../provisioners/ssh";
import {
  lockSession,
  privateCommand,
  sessionConfig,
  sessionStatus,
  ttlSeconds,
  unlockSession,
} from "../session";
import { initDatabase } from "../session/database";
import { createKey, keyReference } from "../session/keys";
import { normalizePublicKey } from "../session/public-key";
import { doctor, paths, setup } from "../setup";
import { transportSpec } from "../transports";
import { HomectlError, type Machine, type ProcessResult } from "../types";
import { renderHelp } from "./help";
export const help = renderHelp();
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
        help: { type: "boolean", short: "h" },
        ttl: { type: "string" },
        database: { type: "string" },
      },
    });
    json = v.json ?? false;
    const [command, host, keyName] = positionals;
    if (
      (v.ttl || v.database) &&
      (command !== "session" || host !== "configure")
    )
      throw new HomectlError(
        2,
        "--ttl and --database apply only to session configure",
      );
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
      emit(
        renderHelp(command === "help" ? host : command, {
          width: process.stdout.columns,
          color: Boolean(
            process.stdout.isTTY &&
              !json &&
              process.env.NO_COLOR === undefined &&
              process.env.TERM !== "dumb",
          ),
        }),
      );
      return 0;
    }
    if (command === "setup") {
      if (v.inventory)
        throw new HomectlError(
          2,
          "setup uses the standard per-user directory; use --inventory on later commands",
        );
      const result = await setup(p.home, dryRun);
      emit(result);
      return 0;
    }
    const inv = await loadInventory(inventoryPath);
    if (positionals.length > (command === "key" ? 3 : 2))
      throw new HomectlError(
        2,
        "Unexpected positional arguments; commands require the -- separator",
      );
    if (command === "session") {
      if (commandArgs.length)
        throw new HomectlError(
          2,
          "Session commands do not accept command argv",
        );
      if (host === "status") {
        if (dryRun) {
          emit({ wouldCheck: "session", credentialFetch: false });
          return 0;
        }
        emit({
          ...(await sessionStatus(inventoryPath)),
          ...sessionConfig(inv, inventoryPath),
        });
        return 0;
      }
      if (host === "configure") {
        const config = sessionConfig(inv, inventoryPath);
        inv.session = {
          ttl: v.ttl ?? config.ttl,
          database: v.database ? resolve(v.database) : config.database,
        };
        ttlSeconds(inv.session.ttl);
        (await import("../inventory")).parseInventory(JSON.stringify(inv));
        if (!dryRun) {
          await lockSession(inventoryPath);
          await saveInventory(inventoryPath, inv);
        }
        emit({
          session: inv.session,
          dryRun,
          note: "Configuration persists; changing it locks the current session. TTL starts on the next unlock.",
        });
        return 0;
      }
      if (host === "init") {
        if (dryRun) {
          emit({
            wouldCreate: sessionConfig(inv, inventoryPath).database,
            credentialFetch: false,
          });
          return 0;
        }
        emit(await initDatabase(inv, inventoryPath));
        return 0;
      }
      if (host === "unlock" || host === "lock") {
        if (dryRun) {
          emit({ would: host, credentialFetch: false });
          return 0;
        }
        emit(
          host === "unlock"
            ? await unlockSession(inv, inventoryPath)
            : await lockSession(inventoryPath),
        );
        return 0;
      }
      throw new HomectlError(
        2,
        "Use session configure, init, unlock, status or lock",
      );
    }
    if (command === "key") {
      if (commandArgs.length)
        throw new HomectlError(2, "Key commands do not accept command argv");
      if (!keyName || !["create", "inspect"].includes(host ?? ""))
        throw new HomectlError(
          2,
          "Use key create <name> or key inspect <name>",
        );
      const auth = keyReference(keyName, inventoryPath);
      if (dryRun) {
        emit({ name: keyName, auth, would: host, credentialFetch: false });
        return 0;
      }
      emit(
        host === "create"
          ? await createKey(keyName, inv, inventoryPath)
          : {
              name: keyName,
              auth,
              publicKey: normalizePublicKey(
                await readFile(auth.public_key, "utf8"),
              ),
            },
      );
      return 0;
    }
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
      const plan = planProvision(
        request,
        provider.node,
        keyReference(request.name, inventoryPath),
      );
      const providerHost = resolveHost(inv, provider.host);
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
      const publicKey = normalizePublicKey(
        await readFile(plan.machine.auth?.public_key ?? "", "utf8"),
      );
      if (publicKey !== normalizePublicKey(request.public_key))
        throw new HomectlError(
          2,
          "VM public key must match key create <vm-name>; inspect the generated public key",
        );
      if (!(await sessionStatus(inventoryPath)).unlocked)
        throw new HomectlError(
          5,
          "Session locked; unlock privately before provisioning",
        );
      try {
        await privateCommand(
          ["ssh-add", "-T", plan.machine.auth?.public_key ?? ""],
          undefined,
          { SSH_AUTH_SOCK: plan.machine.auth?.socket ?? "" },
        );
      } catch {
        throw new HomectlError(
          5,
          "VM key is not available in the managed agent; run key create <vm-name> privately to reload it before provisioning",
        );
      }
      await writeSSHConfig(configPath, inv.machines);
      await proxmox.apply(
        plan,
        proxmoxSSH(provider, providerHost, configPath),
        p.state,
      );
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
            credentialSpec(
              plan.machine.auth,
              transportSpec(
                plan.machine,
                [...privilege, "apt-get", "update"],
                configPath,
              ),
              workerPath,
            ),
          ),
        );
        if (software === "bun")
          await checked(
            await run(
              credentialSpec(
                plan.machine.auth,
                transportSpec(
                  plan.machine,
                  [...privilege, "apt-get", "install", "-y", "nodejs", "npm"],
                  configPath,
                ),
                workerPath,
              ),
            ),
          );
        await checked(
          await run(
            credentialSpec(
              plan.machine.auth,
              transportSpec(plan.machine, recipe, configPath),
              workerPath,
            ),
          ),
        );
        await checked(
          await run(
            credentialSpec(
              plan.machine.auth,
              transportSpec(
                plan.machine,
                software === "docker"
                  ? [...privilege, "docker", "version"]
                  : ["bun", "--version"],
                configPath,
              ),
              workerPath,
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
