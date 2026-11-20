// Peer workspace commands: `peers`, `pair`, `sync` and `peer`. They talk to the
// local serve instance through its authenticated local API (src/peer/local-api).
// Moved out of main.ts unchanged, so main.ts stays command routing only.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HomectlError } from "../types";
import { confirm } from "./prompts";

export interface PeerCommandContext {
  command: string | undefined;
  host: string | undefined;
  keyName: string | undefined;
  positionals: string[];
  commandArgs: string[];
  values: {
    interface?: string;
    address?: string;
    target?: string;
    impact?: string;
    file?: string;
  };
  json: boolean;
  dryRun: boolean;
  inventoryPath: string;
  configPath: string;
  emit: (result: unknown) => void;
}

// Returns an exit code, or undefined when the command is not a peer command.
export async function peerCommand(
  ctx: PeerCommandContext,
): Promise<number | undefined> {
  const {
    command,
    host,
    keyName,
    positionals,
    commandArgs,
    json,
    dryRun,
    inventoryPath,
    configPath,
    emit,
  } = ctx;
  const v = ctx.values;
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
    if (command === "pair" && !host) {
      if (json)
        throw new HomectlError(
          2,
          "Interactive pairing does not support --json; use explicit pair subcommands",
        );
      await (
        await import("../peer/interactive")
      ).interactivePair(inventoryPath, configPath, v.interface, v.address);
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
    if (command === "pair" && host === "join") {
      if (!v.address)
        throw new HomectlError(
          2,
          "Use home-ctl pair join --address http://<device-LAN-IP>:7448",
        );
      if (json)
        throw new HomectlError(
          2,
          "Guided pairing is interactive; omit --json so the one-time code stays private",
        );
      await (
        await import("../peer/interactive")
      ).interactivePair(inventoryPath, configPath, v.interface, v.address);
      return 0;
    }
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
      if (host === "confirm") {
        const state = await localApi<{
          pair: { sas?: string; remote?: { id?: string; name?: string } };
        }>(inventoryPath, "/api/state");
        if (!state.pair?.sas)
          throw new HomectlError(
            3,
            "No verified pairing awaiting confirmation",
          );
        console.log("Compare on both devices:", state.pair.sas);
        if (!(await confirm("Does this phrase match on both devices?")))
          throw new HomectlError(3, "Pairing cancelled: phrase not confirmed");
        const result = await localApi<{
          pair: { remote?: { id?: string; name?: string } } | null;
          peers: { id: string; name: string }[];
        }>(inventoryPath, "/api/pair/confirm", {
          permissions: {
            sync: true,
            diagnostics: false,
            operations: [],
            administer: false,
          },
        });
        emit(result.pair);
        const remote = result.pair?.remote;
        if (
          !json &&
          remote?.id &&
          remote.name &&
          result.peers.some((peer) => peer.id === remote.id)
        )
          console.log(
            `Paired with ${remote.name}. To change its permissions, open home-ctl panel → Sync → Permissions for that device.`,
          );
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
        emit(await localApi(inventoryPath, "/api/sync/start", { id: keyName }));
        return 0;
      }
      if (host === "apply") {
        if (!v.file)
          throw new HomectlError(
            4,
            "Review the preview, then provide explicit choices with --file PATH",
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
        throw new HomectlError(2, "Use peer <id> --target <host> -- <argv...>");
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
  return undefined;
}
