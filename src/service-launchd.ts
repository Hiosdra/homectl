// macOS background service: a user LaunchAgent that runs `homectl serve` at login and
// restarts it after a failure. Only a user agent is installed; no root is needed.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selfCommand } from "./internal";
import { privateDirectory, protect } from "./platform";
import { run } from "./process";
import { HomectlError } from "./types";

export const LAUNCH_LABEL = "com.hiosdra.homectl";

export function launchdPaths(home: string) {
  return {
    plist: join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`),
    log: join(home, "Library", "Logs", "homectl.log"),
  };
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(
  inventory: string,
  interfaceIP: string,
  log: string,
) {
  const args = [
    ...selfCommand(),
    "serve",
    "--inventory",
    inventory,
    "--interface",
    interfaceIP,
  ]
    .map((value) => `    <string>${xml(value)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCH_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ProcessType</key><string>Background</string>",
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "  <key>umask</key><integer>63</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

type LaunchdOptions = {
  inventory: string;
  interfaceIP: string;
  home: string;
  dryRun?: boolean;
};

// The user domain for launchctl, for example gui/501.
function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new HomectlError(5, "launchctl needs a user id");
  return `gui/${uid}`;
}

export async function launchdService(action: string, options: LaunchdOptions) {
  const paths = launchdPaths(options.home);
  if (options.dryRun)
    return {
      action,
      path: paths.plist,
      platform: "darwin",
      interface: options.interfaceIP,
      credentialAccess: false,
    };
  const target = () => `${domain()}/${LAUNCH_LABEL}`;
  if (action === "install") {
    if (await Bun.file(paths.plist).exists())
      throw new HomectlError(
        3,
        "Service configuration already exists; it will not be overwritten",
      );
    await privateDirectory(join(options.home, "Library", "LaunchAgents"));
    await writeFile(
      paths.plist,
      launchdPlist(options.inventory, options.interfaceIP, paths.log),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await protect(paths.plist);
    return {
      installed: true,
      next: "Run homectl service start to start it now. It starts at every login after that.",
    };
  }
  if (action === "start") {
    const loaded = await run({
      argv: ["launchctl", "bootstrap", domain(), paths.plist],
    });
    if (loaded.exitCode)
      return run({ argv: ["launchctl", "kickstart", "-k", target()] });
    return loaded;
  }
  if (action === "stop")
    return run({ argv: ["launchctl", "bootout", target()] });
  if (action === "restart")
    return run({ argv: ["launchctl", "kickstart", "-k", target()] });
  if (action === "status")
    return run({ argv: ["launchctl", "print", target()] });
  if (action === "logs") {
    const text = await Bun.file(paths.log)
      .text()
      .catch(() => "");
    return { log: text.split("\n").slice(-100).join("\n") };
  }
  if (action === "uninstall") {
    await run({ argv: ["launchctl", "bootout", target()] });
    await rm(paths.plist, { force: true });
    return { uninstalled: true };
  }
  throw new HomectlError(
    2,
    "Use service install, uninstall, start, stop, restart, status or logs",
  );
}
