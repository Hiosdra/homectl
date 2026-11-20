#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { credentialSpec } from "../credentials";

import { enroll, installSudo } from "../enroll";
import { loadInventory, resolveHost, saveInventory } from "../inventory";
import { workerArgv, writeSSHConfig } from "../operations";
import { windows } from "../platform";
import { run } from "../process";
import { type ProvisionRequest, planProvision, proxmox } from "../provisioners";
import { proxmoxSSH } from "../provisioners/ssh";
import {
  lockSession,
  privateCommand,
  sessionConfig,
  sessionStatus,
  ttlSeconds,
} from "../session";
import { initDatabase } from "../session/database";
import { createKey, inspectKey, keyReference } from "../session/keys";
import { normalizePublicKey } from "../session/public-key";
import { paths } from "../setup";
import { transportSpec } from "../transports";
import { HomectlError, type Machine, type ProcessResult } from "../types";
import { runUpdate } from "../update";
import { brokerCli } from "./broker-commands";
import { runLocalCliCommand } from "./commands";
import { helpTopics, renderHelp } from "./help";
import { hostCommand } from "./host-commands";
import { runInternal } from "./internal-roles";
import { knownCommands } from "./known-commands";
import { formatError, formatHuman, normalizeCliError } from "./output";
import { migrateCommand } from "./migrate-command";
import { peerCommand } from "./peer-commands";
export const help = renderHelp();

async function panelInterface(inventoryPath: string, requested?: string) {
  if (requested) return requested;
  const { lanAddresses } = await import("../peer/interactive");
  const addresses = lanAddresses();
  try {
    const saved = JSON.parse(
      await readFile(
        join(dirname(inventoryPath), "setup-preferences.json"),
        "utf8",
      ),
    );
    if (addresses.includes(saved.interface)) return saved.interface as string;
  } catch {
    /* No valid saved LAN preference. */
  }
  if (addresses.length === 1) return addresses[0] ?? "127.0.0.1";
  if (!addresses.length) return "127.0.0.1";
  console.log("Choose where other devices can reach this workspace:");
  addresses.forEach((address, index) => {
    console.log(`${index + 1}. ${address}`);
  });
  console.log(`${addresses.length + 1}. This computer only`);
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const value = (await input.question("Choose an option: ")).trim();
      const number = Number(value);
      if (/^\d+$/.test(value) && number >= 1 && number <= addresses.length + 1)
        return addresses[number - 1] ?? "127.0.0.1";
      console.log(`Enter a number from 1 to ${addresses.length + 1}.`);
    }
  } finally {
    input.close();
  }
}

export async function main(raw = process.argv.slice(2)): Promise<number> {
  // Internal roles that homectl starts for itself (src/cli/internal-roles.ts).
  if (raw[0] === "__internal") return runInternal(raw[1]);
  const split = raw.indexOf("--");
  const cliArgs = split < 0 ? raw : raw.slice(0, split);
  const commandArgs = split < 0 ? [] : raw.slice(split + 1);
  let json = cliArgs.includes("--json");
  try {
    // Broker commands parse their own options and do not know --help, so their
    // help is answered here, before they run.
    const [topic] = cliArgs;
    if (
      topic &&
      helpTopics.includes(topic) &&
      cliArgs.some((arg) => arg === "--help" || arg === "-h")
    ) {
      console.log(renderHelp(topic, { width: process.stdout.columns }));
      return 0;
    }
    const brokerResult = await brokerCli(raw, json);
    if (brokerResult !== undefined) return brokerResult;
    const { values: v, positionals } = parseArgs({
      args: cliArgs,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string" },
        "peer-port": { type: "string" },
        interface: { type: "string" },
        "no-discovery": { type: "boolean" },
        "no-control-sync": { type: "boolean" },
        container: { type: "boolean" },
        "panel-interface": { type: "string" },
        "panel-origin": { type: "string" },
        "panel-token-file": { type: "string" },
        owner: { type: "string" },
        cancel: { type: "boolean" },
        reason: { type: "string" },
        issuer: { type: "string" },
        audience: { type: "string" },
        "jwks-url": { type: "string" },
        "max-lifetime": { type: "string" },
        "oidc-subject": { type: "string" },
        "oidc-client-id": { type: "string" },
        wrapper: { type: "string" },
        address: { type: "string" },
        target: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        rollback: { type: "boolean" },
        task: { type: "boolean" },
        "install-deps": { type: "boolean" },
        "configure-firewall": { type: "boolean" },
        inventory: { type: "string" },
        mode: { type: "string" },
        file: { type: "string" },
        id: { type: "string" },
        "parameters-file": { type: "string" },
        name: { type: "string" },
        scopes: { type: "string" },
        hosts: { type: "string" },
        "token-file": { type: "string" },
        to: { type: "string" },
        out: { type: "string" },
        key: { type: "string" },
        bundle: { type: "string" },
        host: { type: "string" },
        state: { type: "string" },
        all: { type: "boolean" },
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
    if (
      (v.id !== undefined || v["parameters-file"] !== undefined) &&
      command !== "commands"
    )
      throw new HomectlError(
        2,
        "--id and --parameters-file apply only to commands",
      );
    if (
      [
        v.name,
        v.scopes,
        v.hosts,
        v["token-file"],
        v.state,
        v.all,
        v.to,
        v.owner,
        v.cancel,
        v.reason,
        v["max-lifetime"],
        v.issuer,
        v.audience,
        v["jwks-url"],
        v["oidc-subject"],
        v["oidc-client-id"],
        v.out,
        v.key,
        v.bundle,
      ].some((option) => option !== undefined) &&
      command !== "control"
    )
      throw new HomectlError(
        2,
        "--name, --scopes, --hosts, --token-file, --state, --all, --to, --owner, --cancel, --reason, --out, --key, --bundle and the OIDC options apply only to control",
      );
    if (v.host !== undefined && command !== "serve-mcp")
      throw new HomectlError(2, "--host applies only to serve-mcp");
    if (v.container && command !== "serve")
      throw new HomectlError(2, "--container applies only to serve");
    const remotePanelArgs = [
      v["panel-interface"],
      v["panel-origin"],
      v["panel-token-file"],
    ];
    if (remotePanelArgs.some((value) => value !== undefined)) {
      if (command !== "serve" || !v.container)
        throw new HomectlError(
          2,
          "Remote panel options apply only to serve --container",
        );
      if ((["panel-interface", "panel-origin"] as const).some((key) => !v[key]))
        throw new HomectlError(
          2,
          "Remote panel needs --panel-interface and --panel-origin; --panel-token-file is optional",
        );
    }
    const p = paths();
    const inventoryPath = v.inventory ? resolve(v.inventory) : p.inventory;
    const configPath = v.inventory ? `${inventoryPath}.ssh_config` : p.ssh;
    const dryRun = v["dry-run"] ?? false;
    const emit = (result: unknown) =>
      console.log(
        json ? JSON.stringify(result) : formatHuman(result, command, host),
      );
    if (!command || v.help || command === "help") {
      const topic = command === "help" ? host : command;
      if (topic && !knownCommands.has(topic))
        throw new HomectlError(
          2,
          `Unknown command: ${topic}; use home-ctl help`,
        );
      emit(
        renderHelp(topic && helpTopics.includes(topic) ? topic : "", {
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
    if ((v["install-deps"] || v["configure-firewall"]) && command !== "setup")
      throw new HomectlError(
        2,
        "--install-deps and --configure-firewall are only supported by setup",
      );
    await (await import("../skill-install")).refreshManagedSkills();
    if (command === "update") {
      emit(await runUpdate(positionals, commandArgs, v.inventory, dryRun, v));
      return 0;
    }
    if (command === "setup") {
      if (v.inventory)
        throw new HomectlError(
          2,
          "setup uses the standard per-user directory; use --inventory on later commands",
        );
      const result = await (
        await import("../setup-flow")
      ).setupFlow({
        home: p.home,
        json,
        dryRun,
        installDeps: Boolean(v["install-deps"]),
        configureFirewall: Boolean(v["configure-firewall"]),
        interface: v.interface,
      });
      emit(result);
      if ("doctor" in result && result.doctor && !result.doctor.ok) return 5;
      return 0;
    }
    const peer = await peerCommand({
      command,
      host,
      keyName,
      positionals,
      commandArgs,
      values: v,
      json,
      dryRun,
      inventoryPath,
      configPath,
      emit,
    });
    if (peer !== undefined) return peer;
    if (command === "migrate") {
      emit(
        await migrateCommand(
          positionals,
          commandArgs,
          inventoryPath,
          dryRun,
          v.mode,
        ),
      );
      return 0;
    }
    if (command === "service") {
      emit(
        await (
          await import("../service")
        ).serviceFromFlags(host, {
          ...v,
          inventory: inventoryPath,
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

      if (v.json)
        throw new HomectlError(
          3,
          "Panel launch tokens cannot be emitted as JSON",
        );

      if (!process.stdin.isTTY)
        throw new HomectlError(
          5,
          "Run home-ctl panel yourself in a private terminal; the launch address contains a local access token",
        );
      let existing: { peerAddress?: string } | undefined;
      try {
        existing = await (
          await import("../peer/local-api")
        ).localApi(inventoryPath, "/api/state");
      } catch {
        /* Start a temporary workspace below. */
      }
      let running:
        Awaited<ReturnType<typeof import("../serve").serve>> | undefined;
      if (!existing) {
        const interfaceIP = await panelInterface(inventoryPath, v.interface);
        running = await (
          await import("../serve")
        ).serve({
          inventoryPath,
          configPath,
          interface: interfaceIP,
          discover: interfaceIP !== "127.0.0.1",
        });
        console.log(
          interfaceIP === "127.0.0.1"
            ? "Started a temporary workspace on this computer only."
            : `Started a temporary workspace for your LAN (${interfaceIP}).`,
        );
      } else if (
        v.interface &&
        existing.peerAddress &&
        new URL(existing.peerAddress).hostname !== v.interface
      ) {
        throw new HomectlError(
          3,
          "A workspace is already running on another interface. Stop it in its terminal or service before changing interfaces.",
        );
      }
      const launch = JSON.parse(
        await readFile(
          join(dirname(inventoryPath), "serve", "panel.json"),
          "utf8",
        ),
      ) as { url: string; token: string };
      const url = `${launch.url}/#token=${encodeURIComponent(launch.token)}`;
      console.log("Opening the local home-ctl panel.");
      const child = Bun.spawn(
        windows
          ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
          : [process.platform === "darwin" ? "open" : "xdg-open", url],
        { stdout: "ignore", stderr: "ignore", windowsHide: true },
      );
      if (await child.exited) console.log("Open this address privately:", url);
      if (running) {
        console.log(
          "Keep this terminal open while you use the panel. Press Ctrl+C to stop it.",
        );
        await new Promise<void>((done) => {
          const stop = () =>
            void running?.stop().finally(() => {
              process.off("SIGINT", stop);
              process.off("SIGTERM", stop);
              done();
            });
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      }
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
          remotePanel: v["panel-interface"]
            ? {
                interface: v["panel-interface"],
                origin: v["panel-origin"],
                tokenFile: v["panel-token-file"],
              }
            : undefined,
          interface: v.interface ?? "127.0.0.1",
          credentialAccess: false,
        });
        return 0;
      }
      if (v.container) {
        if (v.interface === undefined)
          throw new HomectlError(
            2,
            "Container mode needs --interface with the container LAN address; wildcard binding is refused",
          );
        return await (
          await import("../container/run")
        ).serveContainer({
          inventoryPath,
          configPath,
          interface: v.interface,
          port: port(v.port, 7447),
          peerPort: port(v["peer-port"], 7448),
          panelInterface: v["panel-interface"],
          panelOrigin: v["panel-origin"],
          panelTokenFile: v["panel-token-file"],
        });
      }
      let existing: { peerAddress?: string } | undefined;
      try {
        existing = await (
          await import("../peer/local-api")
        ).localApi(inventoryPath, "/api/state");
      } catch {
        /* No authenticated running workspace. */
      }
      if (existing) {
        if (
          v.interface &&
          existing.peerAddress &&
          new URL(existing.peerAddress).hostname !== v.interface
        )
          throw new HomectlError(
            3,
            "A workspace is already running on another interface. Stop it in its terminal or service before changing interfaces.",
          );
        emit({
          running: true,
          peers: existing.peerAddress,
          next: "Workspace is already running. Use home-ctl panel to open it. To stop the temporary workspace, press Ctrl+C in the terminal running home-ctl pair/serve.",
        });
        return 0;
      }
      const running = await (
        await import("../serve")
      ).serve({
        inventoryPath,
        configPath,
        port: port(v.port, 7447),
        peerPort: port(v["peer-port"], 7448),
        interface: v.interface,
        discover: !v["no-discovery"],
        controlSync: !v["no-control-sync"],
      });
      emit({
        panel: running.url,
        peers: running.address,
        next: "Run home-ctl panel in your private terminal. New pairing is closed until opened in the panel.",
      });
      await new Promise<void>((done) => {
        const stop = () => void running.stop().finally(done);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    if (command === "serve-mcp") {
      if (positionals.length > 1 || commandArgs.length)
        throw new HomectlError(
          2,
          "Usage: home-ctl serve-mcp [--host 127.0.0.1] [--port 7449] [--inventory PATH]",
        );
      if (dryRun) {
        emit({
          wouldServe: "mcp",
          bind: "127.0.0.1",
          port: v.port ?? "7449",
          credentialAccess: false,
        });
        return 0;
      }
      await (
        await import("../control/cli")
      ).serveMcp(
        { inventoryPath, configPath, positionals, values: v, dryRun, json },
        (value, human) => console.log(json ? JSON.stringify(value) : human),
      );
      return 0;
    }
    if (command === "control") {
      const result = await (
        await import("../control/cli")
      ).controlCommand({
        inventoryPath,
        configPath,
        positionals: positionals.slice(1),
        values: v,
        dryRun,
        json,
      });
      console.log(json ? JSON.stringify(result.value) : result.human);
      return result.code;
    }
    const localCommandResult = await runLocalCliCommand({
      command,
      host,
      positionals,
      commandArgs,
      dryRun,
      inventoryPath,
      configPath,
      values: v,
      emit,
    });
    if (localCommandResult !== undefined) return localCommandResult;
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
          await (
            await import("../session/workspace")
          ).sessionWorkspace(host, inv, inventoryPath),
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
          : await inspectKey(keyName, auth),
      );
      return 0;
    }
    const hostResult = await hostCommand(command, host, {
      inventory: inv,
      inventoryPath,
      configPath,
      commandArgs,
      dryRun,
      impact: v.impact,
      emit,
    });
    if (hostResult !== undefined) return hostResult;
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
            workerArgv,
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
          workerArgv,
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
              workerArgv,
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
                workerArgv,
              ),
            ),
          );
        await checked(
          await run(
            credentialSpec(
              plan.machine.auth,
              transportSpec(plan.machine, recipe, configPath),
              workerArgv,
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
              workerArgv,
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
    throw new HomectlError(2, "Unknown command; use home-ctl help");
  } catch (e) {
    const error = normalizeCliError(e);
    console.error(
      json
        ? JSON.stringify({
            error: error.message,
            code: error.code,
            ...(error.details ? { details: error.details } : {}),
          })
        : formatError(error.message, error.code, error.details),
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
