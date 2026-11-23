// `home-ctl start`: the broker and the owner panel in one window. The panel
// origin is set for the owner (no environment variable to type), the panel opens
// in the browser unless --no-open or there is no display, and Ctrl+C stops both.
// `daemon run` and `daemon panel` stay for advanced use.
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { callBroker, findEndpoint } from "../broker/client";
import type { Endpoint } from "../broker/paths";
import { compatPaths } from "../broker/paths";
import { HomectlError } from "../types";

// The part of the panel address the browser opens. While setup is incomplete (no
// completion mark in broker/setup.json), it opens the guided setup; otherwise the
// inbox. Only a section name goes in the address, never a token.
export async function openingHash(stateDirectory: string): Promise<string> {
  try {
    const file = JSON.parse(
      await readFile(join(stateDirectory, "setup.json"), "utf8"),
    ) as { completedAt?: unknown; dismissedAt?: unknown };
    return typeof file.completedAt === "number" ||
      typeof file.dismissedAt === "number"
      ? ""
      : "#/setup";
  } catch {
    // No setup file yet: a fresh broker, so setup is incomplete.
    return "#/setup";
  }
}

export const PANEL_PORT_FIRST = 7451;
export const PANEL_PORT_LAST = 7470;
const LOOPBACK_HOST = "127.0.0.1";

export interface PanelPlan {
  port: number;
  origin: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

// Whether a loopback port can be bound right now.
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, LOOPBACK_HOST, () => {
      probe.close(() => resolve(true));
    });
  });
}

// Chooses the owner panel's address and origin.
//
// Default: http://127.0.0.1:7451, or the first free port up to 7470. The broker
// and the panel are told the same origin, so sign-in works without any variable.
//
// Overrides: HOMECTL_OWNER_PANEL_PORT picks the port. HOMECTL_PANEL_ORIGIN names
// the origin exactly (for an https reverse proxy you run, with HOMECTL_PANEL_LISTEN
// set). A loopback origin must be 127.0.0.1: the panel answers only as that host.
export async function planPanel(
  env: Env,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<PanelPlan> {
  const origin = env.HOMECTL_PANEL_ORIGIN?.trim() || undefined;
  const explicitPort = env.HOMECTL_OWNER_PANEL_PORT?.trim() || undefined;
  if (origin !== undefined) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new HomectlError(
        2,
        `HOMECTL_PANEL_ORIGIN must be a web address such as http://127.0.0.1:${PANEL_PORT_FIRST}`,
      );
    }
    if (url.hostname === "localhost")
      throw new HomectlError(
        2,
        `HOMECTL_PANEL_ORIGIN must use 127.0.0.1, not localhost: the panel answers only as 127.0.0.1, such as http://127.0.0.1:${PANEL_PORT_FIRST}`,
      );
    if (url.hostname === LOOPBACK_HOST) {
      if (!url.port)
        throw new HomectlError(
          2,
          `HOMECTL_PANEL_ORIGIN needs a port, such as http://127.0.0.1:${PANEL_PORT_FIRST}`,
        );
      return { port: Number(url.port), origin: `http://${url.host}` };
    }
    if (!env.HOMECTL_PANEL_LISTEN?.trim())
      throw new HomectlError(
        2,
        "HOMECTL_PANEL_ORIGIN names another address, so HOMECTL_PANEL_LISTEN must also be set (an IP address the panel listens on).",
      );
    return {
      port: explicitPort ? parsePort(explicitPort) : await firstFree(isFree),
      origin: url.origin,
    };
  }
  const port = explicitPort ? parsePort(explicitPort) : await firstFree(isFree);
  return { port, origin: `http://${LOOPBACK_HOST}:${port}` };
}

function parsePort(text: string): number {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new HomectlError(2, "HOMECTL_OWNER_PANEL_PORT must be a port number");
  return port;
}

async function firstFree(isFree: (port: number) => Promise<boolean>) {
  for (let port = PANEL_PORT_FIRST; port <= PANEL_PORT_LAST; port += 1)
    if (await isFree(port)) return port;
  throw new HomectlError(
    5,
    `No free port between ${PANEL_PORT_FIRST} and ${PANEL_PORT_LAST}. Set HOMECTL_OWNER_PANEL_PORT to a free port and run home-ctl start again.`,
  );
}

// The command that opens a URL in the default browser on this platform.
export function openCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "win32")
    return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
  return [platform === "darwin" ? "open" : "xdg-open", url];
}

// No display (a server, SSH session or NAS shell): do not try to open a browser.
export function hasDisplay(platform: NodeJS.Platform, env: Env): boolean {
  if (platform !== "linux") return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

export interface StartOptions {
  inventoryPath: string;
  sshConfigPath: string;
  open: boolean;
  env?: Env;
  // Test seam: the browser opener. Default: the platform's command.
  openUrl?: (url: string) => void;
  // Test seam: resolves when the owner presses Ctrl+C (or the process is stopped).
  waitForStop?: () => Promise<void>;
}

function openBrowser(options: StartOptions, url: string, env: Env): void {
  if (!options.open || !hasDisplay(process.platform, env)) return;
  if (options.openUrl) {
    options.openUrl(url);
    return;
  }
  try {
    Bun.spawn(openCommand(process.platform, url), {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    console.log(`Open this address in your browser: ${url}`);
  }
}

function waitForCtrlC(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// A broker that answers, so the panel can be added to it.
async function liveBroker(
  endpoint: Endpoint | undefined,
): Promise<Endpoint | undefined> {
  if (!endpoint) return undefined;
  const reachable = await callBroker(
    "/v1/whoami",
    {},
    { endpoint, timeoutMs: 3000 },
  )
    .then(() => true)
    .catch((error: HomectlError) => /Client token/.test(error.message));
  return reachable ? endpoint : undefined;
}

export async function startCommand(options: StartOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stop = options.waitForStop ?? waitForCtrlC;
  const stateDir = compatPaths(options.inventoryPath).state;
  const running = await liveBroker(await findEndpoint(options.inventoryPath));

  if (running) {
    // Reuse the broker. It can only be joined by a panel at the origin it was
    // started with, so a broker without a panel needs a restart.
    if (!running.panel)
      throw new HomectlError(
        3,
        "homectl is already running without its owner panel. Close the window it runs in (Ctrl+C), then run home-ctl start again.",
      );
    const origin = running.panel;
    const port = Number(new URL(origin).port || 80);
    if (!(await isPortFree(port))) {
      console.log(
        `homectl is already running. Open the owner panel: ${origin}`,
      );
      openBrowser(options, origin + (await openingHash(stateDir)), env);
      return 0;
    }
    const { startOwnerPanel } = await import("../web/owner/server");
    const panel = await startOwnerPanel({
      inventoryPath: options.inventoryPath,
      port,
      origin,
    });
    console.log(
      `homectl is running. Open the owner panel: ${panel.origin}. Keep this window open. Ctrl+C stops the panel.`,
    );
    openBrowser(options, panel.origin + (await openingHash(stateDir)), env);
    await stop();
    panel.stop();
    return 0;
  }

  const plan = await planPanel(env);
  const { startDaemon } = await import("../broker/daemon");
  const { workspaceFromEnv } = await import("../workspace/wiring");
  const workspace = workspaceFromEnv();
  const paths = compatPaths(options.inventoryPath);
  const daemon = await startDaemon({
    mode: "compat",
    ...paths,
    inventoryPath: options.inventoryPath,
    sshConfigPath: options.sshConfigPath,
    ...(workspace ? { workspace } : {}),
    panelOrigin: plan.origin,
  });
  const { startOwnerPanel } = await import("../web/owner/server");
  let panel: Awaited<ReturnType<typeof startOwnerPanel>>;
  try {
    panel = await startOwnerPanel({
      inventoryPath: options.inventoryPath,
      port: plan.port,
      origin: plan.origin,
    });
  } catch (error) {
    await daemon.stop();
    throw error;
  }
  if (!(await daemon.verifier.exists()))
    console.log(
      "No owner password is set yet. Run home-ctl setup first; the password you choose there also signs you in to the panel.",
    );
  console.log(
    `homectl is running. Open the owner panel: ${panel.origin}. Keep this window open. Ctrl+C stops homectl.`,
  );
  openBrowser(options, panel.origin + (await openingHash(stateDir)), env);
  await stop();
  panel.stop();
  await daemon.stop();
  return 0;
}
