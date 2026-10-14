import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { privateDirectory, protect, windows } from "./platform";
import { run } from "./process";
import { HomectlError } from "./types";
export type ServiceOptions = {
  inventory: string;
  interface?: string;
  wrapper?: string;
  dryRun?: boolean;
  home?: string;
};
export function systemdUnit(inventory: string, interfaceIP: string) {
  const quote = (v: string) =>
    `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return `[Unit]\nDescription=homectl peer workspace\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(resolve(import.meta.dir, "cli/main.ts"))} serve --inventory ${quote(inventory)} --interface ${quote(interfaceIP)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n`;
}
function xml(v: string) {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export function windowsServiceConfig(inventory: string, interfaceIP: string) {
  const args = [
    resolve(import.meta.dir, "cli/main.ts"),
    "serve",
    "--inventory",
    inventory,
    "--interface",
    interfaceIP,
  ]
    .map((v) => `"${v.replaceAll('"', '\\"')}"`)
    .join(" ");
  return `<service>\n<id>homectl</id><name>homectl peer workspace</name><description>Local homectl panel and peer sync</description>\n<executable>${xml(process.execPath)}</executable><arguments>${xml(args)}</arguments>\n<startmode>Manual</startmode><log mode="roll"/><onfailure action="restart" delay="5 sec"/>\n</service>\n`;
}
export async function service(action: string, options: ServiceOptions) {
  const home = options.home ?? homedir();
  const directory = windows
    ? join(home, ".config", "homectl", "service")
    : join(home, ".config", "systemd", "user");
  const path = join(
    directory,
    windows ? "homectl-service.xml" : "homectl.service",
  );
  const interfaceIP = options.interface ?? "127.0.0.1";
  if (
    ![
      "install",
      "uninstall",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
    ].includes(action)
  )
    throw new HomectlError(
      2,
      "Use service install, uninstall, start, stop, restart, status or logs",
    );
  if (options.dryRun)
    return {
      action,
      path,
      platform: process.platform,
      interface: interfaceIP,
      credentialAccess: false,
    };
  if (action === "install") {
    if (await Bun.file(path).exists())
      throw new HomectlError(
        3,
        "Service configuration already exists; it will not be overwritten",
      );
    if (windows && !options.wrapper)
      throw new HomectlError(
        5,
        "Provide --wrapper with an official WinSW executable; see docs/windows.md",
      );
    await privateDirectory(directory);
    await writeFile(
      path,
      windows
        ? windowsServiceConfig(options.inventory, interfaceIP)
        : systemdUnit(options.inventory, interfaceIP),
      { mode: 0o600, flag: "wx" },
    );
    await protect(path);
    if (windows) {
      await copyFile(
        options.wrapper as string,
        join(directory, "homectl-service.exe"),
      );
      const r = await run({
        argv: [join(directory, "homectl-service.exe"), "install"],
      });
      if (r.exitCode)
        throw new HomectlError(
          5,
          "Windows service installation failed; run from an elevated private terminal",
        );
      return {
        installed: true,
        next: "Before starting, set the service Log On account to your existing Windows user in services.msc. Enter the password there, never in CLI arguments or XML. The service is installed in Manual mode and must not run as SYSTEM. Then use homectl service start.",
      };
    }
    const r = await run({ argv: ["systemctl", "--user", "daemon-reload"] });
    if (r.exitCode)
      throw new HomectlError(
        5,
        "systemd user services unavailable; enable systemd in WSL or use serve temporarily",
      );
    await run({ argv: ["systemctl", "--user", "enable", "homectl.service"] });
    return {
      installed: true,
      next: "Run homectl service start. Starting without login requires explicit loginctl enable-linger configuration.",
    };
  }
  if (windows) {
    const wrapper = join(directory, "homectl-service.exe");
    if (!(await Bun.file(wrapper).exists()))
      throw new HomectlError(5, "Install the Windows service first");
    if (action === "logs") {
      const log = join(directory, "homectl-service.out.log");
      return {
        log: (await readFile(log, "utf8")).split("\n").slice(-100).join("\n"),
      };
    }
    // Refuse SYSTEM execution: account configuration is a private human step.
    if (action === "start" || action === "restart") {
      const query = await run({ argv: ["sc.exe", "qc", "homectl"] });
      if (
        query.exitCode ||
        /LocalSystem|NT AUTHORITY\\SYSTEM/i.test(query.stdout)
      )
        throw new HomectlError(
          3,
          "Configure the service Log On account as your user before starting",
        );
    }
    const r = await run({
      argv: [wrapper, action === "uninstall" ? "uninstall" : action],
    });
    if (r.exitCode)
      throw new HomectlError(
        5,
        "Windows service operation failed; use an elevated private terminal",
      );
    if (action === "uninstall") {
      await rm(path);
      await rm(wrapper);
    }
    return r;
  }
  if (action === "uninstall") {
    await run({
      argv: ["systemctl", "--user", "disable", "--now", "homectl.service"],
    });
    await rm(path);
    return run({ argv: ["systemctl", "--user", "daemon-reload"] });
  }
  return run({
    argv:
      action === "logs"
        ? [
            "journalctl",
            "--user",
            "-u",
            "homectl.service",
            "-n",
            "100",
            "--no-pager",
          ]
        : ["systemctl", "--user", action, "homectl.service"],
  });
}
