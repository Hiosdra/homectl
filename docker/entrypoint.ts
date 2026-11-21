#!/usr/bin/env bun
// Container entrypoint for the 0.3 broker (docs/setup.md, Docker and NAS containers).
//
//   no arguments   start the broker (`daemon run`) and the owner panel
//                  (`daemon panel`) together. When either one exits on its own,
//                  the other is stopped and the container exits with an error.
//   with arguments run `home-ctl <arguments>` instead, for example
//                  `owner init`, `daemon status`, or the legacy
//                  `serve --container ...`.
//
// SIGTERM and SIGINT (docker stop) are forwarded to every child, so the broker
// and the panel stop cleanly. No secret is read here or passed in the environment.
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { paths } from "../src/setup";

export const CLI = resolve(import.meta.dir, "..", "src", "cli", "main.ts");
const DEFAULT_PANEL_PORT = 7451;
// The same empty inventory `home-ctl setup` starts from (no machines).
const EMPTY_INVENTORY = "version: 1\nmachines: {}\n";

// The broker refuses to start without an inventory file, and a new volume has
// none. Create the empty one, owner-only, when it is missing. An existing file
// is never changed.
export async function ensureInventory(
  inventoryPath: string = paths().inventory,
): Promise<boolean> {
  try {
    await access(inventoryPath);
    return false;
  } catch {
    /* Missing: create it below. */
  }
  await mkdir(dirname(inventoryPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(inventoryPath, EMPTY_INVENTORY, {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    // Another process created it first; that file is the one to keep.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

// The owner panel only accepts requests from its own origin, and the broker only
// trusts the origin it was started with. Both come from one place: the panel
// port, unless HOMECTL_PANEL_ORIGIN says otherwise.
export function panelOrigin(env: Record<string, string | undefined>): string {
  return (
    env.HOMECTL_PANEL_ORIGIN ??
    `http://127.0.0.1:${env.HOMECTL_OWNER_PANEL_PORT ?? DEFAULT_PANEL_PORT}`
  );
}

// The address the panel listens on, as binding.ts reads it: blank means unset.
export function panelListen(env: Record<string, string | undefined>): string {
  return env.HOMECTL_PANEL_LISTEN?.trim() || "127.0.0.1";
}

// A bridge-network container publishes the panel only if it listens on a
// non-loopback address, so the owner must then name the browser origin. Without
// it the default origin would be 127.0.0.1, which the panel refuses on that
// address; this check says so before anything starts.
export function originMissingForListen(
  env: Record<string, string | undefined>,
): string | undefined {
  const listen = panelListen(env);
  if (listen === "127.0.0.1" || listen === "::1") return undefined;
  if ((env.HOMECTL_PANEL_ORIGIN ?? "").trim() !== "") return undefined;
  return `HOMECTL_PANEL_LISTEN=${listen} needs HOMECTL_PANEL_ORIGIN: the exact browser origin, for example https://homectl.lan.example.test`;
}

function spawnCli(args: string[], env: Record<string, string>) {
  return Bun.spawn([process.execPath, CLI, ...args], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

// Runs the broker and the panel side by side. Returns the process exit code.
export async function supervise(): Promise<number> {
  const missing = originMissingForListen(process.env);
  if (missing) {
    console.error(missing);
    return 2;
  }
  await ensureInventory();
  const env = {
    ...(process.env as Record<string, string>),
    HOMECTL_PANEL_ORIGIN: panelOrigin(process.env),
  };
  const children = [
    spawnCli(["daemon", "run"], env),
    spawnCli(["daemon", "panel"], env),
  ];
  let signalled = false;
  const forward = (signal: NodeJS.Signals) => {
    for (const child of children) child.kill(signal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    signalled = true;
    forward(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const first = await Promise.race(
      children.map((child) => child.exited.then((code) => code ?? 1)),
    );
    if (!signalled) forward("SIGTERM");
    const [broker] = await Promise.all(children.map((child) => child.exited));
    // A signal is a normal stop: report the broker's own exit code. Any other
    // exit means a child failed; report its code, or 1 if it exited cleanly.
    if (signalled) return broker ?? 1;
    return first || 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

// Runs one home-ctl command with the container's stdio, forwarding signals.
export async function runCommand(args: string[]): Promise<number> {
  const child = spawnCli(args, process.env as Record<string, string>);
  const onSignal = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    return (await child.exited) ?? 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

export function main(args: string[]): Promise<number> {
  return args.length ? runCommand(args) : supervise();
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
