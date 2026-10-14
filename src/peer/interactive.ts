import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { confirm } from "../cli/prompts";
import { readPassword } from "../session";
import { HomectlError } from "../types";
import type { Discovered } from "./discovery";
import { localApi } from "./local-api";

export function pairingRole(localId: string, remoteId: string) {
  return localId.localeCompare(remoteId) < 0 ? "host" : "join";
}
export function lanAddresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter(
          (a) =>
            a &&
            a.family === "IPv4" &&
            !a.internal &&
            /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
        )
        .flatMap((a) => (a ? [a.address] : [])),
    ),
  ];
}
type State = {
  peerAddress: string;
  discovery: { localId?: string; devices: Discovered[]; error?: string };
  pair: null | {
    code?: string;
    sas?: string;
    remote?: { id: string; name: string };
    localConfirmed: boolean;
    remoteConfirmed: boolean;
  };
  peers: { id: string; name: string }[];
};
export async function interactivePair(
  inventoryPath: string,
  configPath: string,
  interfaceIP?: string,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new HomectlError(
      5,
      "Run homectl pair yourself in a private interactive terminal",
    );
  let running: Awaited<ReturnType<typeof import("../serve").serve>> | undefined;
  let opened = false;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const state = () => localApi<State>(inventoryPath, "/api/state");
  const pause = async () => {
    if (abort.signal.aborted) throw new HomectlError(3, "Pairing cancelled");
    await Bun.sleep(1000);
    if (Date.now() > deadline)
      throw new HomectlError(
        3,
        "Pairing expired; run homectl pair on both devices again",
      );
  };
  const deadline = Date.now() + 5 * 60_000;
  const choose = async (prompt: string, count: number) => {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      while (true) {
        const value = await input.question(prompt, { signal: abort.signal });
        const number = Number(value.trim());
        if (/^\d+$/.test(value.trim()) && number >= 1 && number <= count)
          return number - 1;
        console.log(`Enter a number from 1 to ${count}.`);
      }
    } finally {
      input.close();
    }
  };
  try {
    let current: State | undefined;
    try {
      current = await state();
    } catch {
      /* No running local workspace. */
    }
    if (!current) {
      if (!interfaceIP) {
        try {
          const saved = JSON.parse(
            await readFile(
              join(dirname(inventoryPath), "setup-preferences.json"),
              "utf8",
            ),
          );
          if (lanAddresses().includes(saved.interface))
            interfaceIP = saved.interface;
        } catch {
          /* No valid saved LAN preference. */
        }
      }
      if (!interfaceIP) {
        const addresses = lanAddresses();
        if (!addresses.length)
          throw new HomectlError(
            5,
            "No private LAN IPv4 interface found; connect to your LAN or use --interface",
          );
        if (addresses.length === 1) interfaceIP = addresses[0];
        else {
          console.log("Choose the LAN shared by both devices:");
          addresses.forEach((address, i) => {
            console.log(`${i + 1}. ${address}`);
          });
          interfaceIP =
            addresses[await choose("Interface number: ", addresses.length)];
          if (!interfaceIP)
            throw new HomectlError(2, "Invalid interface selection");
        }
      }
      running = await (await import("../serve")).serve({
        inventoryPath,
        configPath,
        interface: interfaceIP,
      });
      current = await state();
    }
    if (!current.discovery.localId || current.discovery.error)
      throw new HomectlError(
        5,
        "LAN discovery is unavailable. Restart serve with --interface <LAN-IP> and discovery enabled, or use pair open/join with a manual address",
      );
    if (current.pair)
      throw new HomectlError(
        3,
        "A pairing is already open; finish it or run homectl pair cancel first",
      );
    const invitation = await localApi<State>(
      inventoryPath,
      "/api/pair/open",
      {},
    );
    opened = true;
    console.log(
      "Pairing mode enabled for five minutes. Run homectl pair on the other device.\nSearching the LAN… Discovery is untrusted until code and phrase verification.",
    );
    console.log(`This device's one-time code (private): ${invitation.pair?.code}
If the other device asks for a code, enter this one there. Never share it in chat.`);
    let selected: Discovered | undefined;
    let warned = false;
    while (!selected) {
      current = await state();
      if (current.pair?.sas) break; // Another device already joined this invitation.
      if (current.discovery.error)
        throw new HomectlError(5, current.discovery.error);
      if (!warned && Date.now() > deadline - 285_000) {
        warned = true;
        console.log(
          "No devices found yet. Check that both computers share this LAN and allow Bun through the private-network firewall (UDP 5353 and TCP 7448). Multicast may be blocked by Wi-Fi isolation or VLANs.",
        );
      }
      const devices = current.discovery.devices;
      if (devices.length === 1) selected = devices[0];
      else if (devices.length > 1) {
        console.log("Choose the device to pair:");
        devices.forEach((device, i) => {
          console.log(`${i + 1}. ${device.address}`);
        });
        selected = devices[await choose("Device number: ", devices.length)];
        if (!selected) throw new HomectlError(2, "Invalid device selection");
      }
      if (!selected) await pause();
    }
    if (selected && !current.pair?.sas) {
      console.log(`Found device at ${selected.address}`);
      if (
        pairingRole(current.discovery.localId ?? "", selected.id) === "join"
      ) {
        const code = await readPassword(
          "Enter the one-time code displayed on the other device: ",
        );
        await localApi(inventoryPath, "/api/pair/join", {
          address: selected.address,
          code,
        });
      } else {
        console.log(
          "Enter this device’s code on the other device. Waiting for verification…",
        );
      }
    }
    while (true) {
      current = await state();
      if (!current.pair)
        throw new HomectlError(
          3,
          "Pairing closed or failed; run homectl pair on both devices again",
        );
      if (current.pair.sas && current.pair.remote) break;
      await pause();
    }
    const verified = current.pair;
    const remote = verified?.remote;
    if (!verified?.sas || !remote)
      throw new HomectlError(3, "Pairing verification lost");
    console.log(
      `Device: ${remote.name}\nCompare this phrase on BOTH devices: ${verified.sas}`,
    );
    if (
      !(await confirm("Does this phrase match on both devices?", abort.signal))
    )
      throw new HomectlError(3, "Pairing cancelled: phrase not confirmed");
    await localApi(inventoryPath, "/api/pair/confirm", {
      permissions: {
        sync: true,
        diagnostics: false,
        operations: [],
        administer: false,
      },
    });
    console.log("Confirmed locally. Waiting for the other device…");
    while (true) {
      current = await localApi<State>(inventoryPath, "/api/pair/poll", {});
      if (current.peers.some((peer) => peer.id === remote.id)) break;
      await pause();
    }
    console.log(
      `Paired with ${remote.name}. Sync permission granted; no credentials transferred.\nUse homectl serve and the panel to review synchronization.`,
    );
    if (running) {
      console.log(
        `Temporary workspace remains running at ${running.url}. Open homectl panel in another terminal to sync. Press Ctrl+C to stop.`,
      );
      while (!abort.signal.aborted) await Bun.sleep(250);
    }
  } finally {
    if (opened)
      await localApi(inventoryPath, "/api/pair/cancel", {}).catch(() => {});
    await running?.stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
