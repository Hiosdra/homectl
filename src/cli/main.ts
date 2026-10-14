#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { credentialSpec } from "../credentials";
import { installDependencies } from "../dependencies";
import { enroll, installSudo } from "../enroll";
import { loadInventory, resolveHost, saveInventory } from "../inventory";
import { execute, workerPath, writeSSHConfig } from "../operations";
import { windows } from "../platform";
import { checkApproval, planExecution } from "../policies";
import { run } from "../process";
import { type ProvisionRequest, planProvision, proxmox } from "../provisioners";
import { proxmoxSSH } from "../provisioners/ssh";
import {
  lockSession,
  privateCommand,
  readPassword,
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
import { update } from "../update";
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
        port: { type: "string" },
        "peer-port": { type: "string" },
        interface: { type: "string" },
        "no-discovery": { type: "boolean" },
        wrapper: { type: "string" },
        address: { type: "string" },
        target: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "install-deps": { type: "boolean" },
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
    if (v["install-deps"] && command !== "setup")
      throw new HomectlError(2, "--install-deps is only supported by setup");
    if (command === "update") {
      if (positionals.length !== 1 || commandArgs.length || v.inventory)
        throw new HomectlError(2, "Usage: homectl update [--dry-run] [--json]");
      emit(await update(dryRun));
      return 0;
    }
    if (command === "setup") {
      if (v.inventory)
        throw new HomectlError(
          2,
          "setup uses the standard per-user directory; use --inventory on later commands",
        );
      const dependencies = v["install-deps"]
        ? await installDependencies(dryRun)
        : undefined;
      const result = await setup(p.home, dryRun);
      const verification =
        !dryRun && v["install-deps"]
          ? await doctor(await loadInventory(p.inventory), p.inventory)
          : undefined;
      emit({
        ...result,
        ...(dependencies ? { dependencies } : {}),
        ...(verification ? { doctor: verification } : {}),
        ...(!v["install-deps"] && windows
          ? {
              hint: "Run homectl setup --install-deps to install missing OpenSSH Client and KeePassXC",
            }
          : {}),
      });
      if (verification && !verification.ok) return 5;
      return 0;
    }
    if (["peers", "pair", "sync", "peer"].includes(command ?? "")) {
      const expected = command === "sync" ? 3 : command === "peers" ? 1 : 2;
      if (
        positionals.length > expected ||
        (command !== "peer" && commandArgs.length)
      )
        throw new HomectlError(2, "Unexpected arguments");
      if (dryRun) {
        emit({
          command,
          action: host,
          id: keyName,
          target: v.target,
          argv: commandArgs,
          credentialAccess: false,
          network: false,
        });
        return 0;
      }
      if (
        command === "pair" &&
        !["open", "join", "confirm", "status", "poll", "cancel"].includes(
          host ?? "",
        )
      )
        throw new HomectlError(
          2,
          "Use pair open, join, confirm, status, poll or cancel",
        );
      const { localApi } = await import("../peer/local-api");
      if (command === "peers") {
        const state = await localApi<{ peers: unknown }>(
          inventoryPath,
          "/api/state",
        );
        emit(state.peers);
        return 0;
      }
      if (command === "pair") {
        if (
          ["open", "join", "confirm"].includes(host ?? "") &&
          !process.stdin.isTTY
        )
          throw new HomectlError(
            5,
            "Run pairing yourself in a private interactive terminal",
          );
        if (host === "open") {
          const result = await localApi<{ pair: unknown }>(
            inventoryPath,
            "/api/pair/open",
            {},
          );
          emit(result.pair);
          return 0;
        }
        if (host === "join") {
          if (!v.address)
            throw new HomectlError(
              2,
              "Use pair join --address with the other device's LAN IP",
            );
          const code = await readPassword("One-time pairing code: ");
          const result = await localApi<{ pair: unknown }>(
            inventoryPath,
            "/api/pair/join",
            { address: v.address, code },
          );
          emit(result.pair);
          return 0;
        }
        if (host === "confirm") {
          const state = await localApi<{ pair: { sas?: string } }>(
            inventoryPath,
            "/api/state",
          );
          if (!state.pair?.sas)
            throw new HomectlError(
              3,
              "No verified pairing awaiting confirmation",
            );
          console.log("Compare on both devices:", state.pair.sas);
          if (
            (await readPassword(
              "Type the matching phrase from both devices: ",
            )) !== state.pair.sas
          )
            throw new HomectlError(3, "Verification phrase does not match");
          const result = await localApi<{ pair: unknown }>(
            inventoryPath,
            "/api/pair/confirm",
            {
              permissions: {
                sync: true,
                diagnostics: false,
                operations: [],
                administer: false,
              },
            },
          );
          emit(result.pair);
          return 0;
        }
        if (host === "cancel") {
          emit(await localApi(inventoryPath, "/api/pair/cancel", {}));
          return 0;
        }
        const state = await localApi<{ pair: Record<string, unknown> | null }>(
          inventoryPath,
          host === "status" ? "/api/state" : "/api/pair/poll",
          host === "status" ? undefined : {},
        );
        if (state.pair) {
          const safe = { ...state.pair };
          delete safe.code;
          emit(safe);
        } else emit({ pairing: false });
        return 0;
      }
      if (command === "sync") {
        if (!keyName)
          throw new HomectlError(
            2,
            "Use sync preview <peer-id>, apply <preview-id> --file choices.json, or cancel <preview-id>",
          );
        if (host === "preview") {
          emit(
            await localApi(inventoryPath, "/api/sync/start", { id: keyName }),
          );
          return 0;
        }
        if (host === "apply") {
          if (!v.file)
            throw new HomectlError(
              4,
              "Review the preview, then provide explicit choices with --file (use {} when there are no conflicts)",
            );
          const choices = JSON.parse(await readFile(resolve(v.file), "utf8"));
          emit(
            await localApi(inventoryPath, "/api/sync/apply", {
              id: keyName,
              choices,
            }),
          );
          return 0;
        }
        if (host === "cancel") {
          emit(
            await localApi(inventoryPath, "/api/sync/cancel", { id: keyName }),
          );
          return 0;
        }
        throw new HomectlError(2, "Unknown sync action");
      }
      if (command === "peer") {
        if (!host || !v.target || !commandArgs.length)
          throw new HomectlError(
            2,
            "Use peer <id> --target <host> -- <argv...>",
          );
        emit(
          await localApi(inventoryPath, "/api/peer/request", {
            id: host,
            action: "exec",
            payload: {
              host: v.target,
              argv: commandArgs,
              dryRun,
              impact: v.impact,
            },
          }),
        );
        return 0;
      }
    }
    if (command === "service") {
      emit(
        await (await import("../service")).service(host ?? "status", {
          inventory: inventoryPath,
          interface: v.interface,
          wrapper: v.wrapper,
          dryRun,
        }),
      );
      return 0;
    }
    if (command === "panel") {
      if (dryRun) {
        emit({ wouldOpenLocalPanel: true, credentialAccess: false });
        return 0;
      }

      if (!process.stdin.isTTY)
        throw new HomectlError(
          5,
          "Run homectl panel yourself in a private terminal; the launch address contains a local access token",
        );
      const launch = JSON.parse(
        await readFile(
          join(
            (await import("node:path")).dirname(inventoryPath),
            "serve",
            "panel.json",
          ),
          "utf8",
        ),
      ) as { url: string; token: string };
      const url = `${launch.url}/#token=${encodeURIComponent(launch.token)}`;
      // Open only on direct private invocation; never return the token in JSON.
      if (v.json)
        throw new HomectlError(
          3,
          "Panel launch tokens cannot be emitted as JSON",
        );
      console.log("Opening the local homectl panel.");
      const child = Bun.spawn(
        windows
          ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
          : [process.platform === "darwin" ? "open" : "xdg-open", url],
        { stdout: "ignore", stderr: "ignore" },
      );
      if (await child.exited) console.log("Open this address privately:", url);
      return 0;
    }
    if (command === "serve") {
      const port = (value: string | undefined, fallback: number) => {
        const n = value === undefined ? fallback : Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 65535)
          throw new HomectlError(2, "Port must be 0 through 65535");
        return n;
      };
      if (dryRun) {
        emit({
          wouldServe: true,
          inventory: inventoryPath,
          panel: "127.0.0.1",
          interface: v.interface ?? "127.0.0.1",
          credentialAccess: false,
        });
        return 0;
      }
      const running = await (await import("../serve")).serve({
        inventoryPath,
        configPath,
        port: port(v.port, 7447),
        peerPort: port(v["peer-port"], 7448),
        interface: v.interface,
        discover: !v["no-discovery"],
      });
      emit({
        panel: running.url,
        peers: running.address,
        next: "Run homectl panel in your private terminal. New pairing is closed until opened in the panel.",
      });
      await new Promise<void>((done) => {
        const stop = () => void running.stop().finally(done);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
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
