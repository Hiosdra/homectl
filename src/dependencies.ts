import { available, windows } from "./platform";
import { privileged } from "./privileged";
import { run } from "./process";
import { HomectlError, type Runner } from "./types";

export async function installDependencies(
  dryRun = false,
  runner: Runner = run,
  tools = available,
  nativeWindows = windows,
  interactive = true,
) {
  if (!nativeWindows)
    throw new HomectlError(
      2,
      "--install-deps currently supports native Windows; install OpenSSH and KeePassXC with your OS package manager on Linux/WSL",
    );
  const missingSSH = !tools("ssh");
  const missingVault = !tools("keepassxc-cli");
  const actions = [
    ...(missingSSH
      ? ["Enable Windows OpenSSH Client (administrator/UAC required)"]
      : []),
    ...(missingVault
      ? ["Install KeePassXC using winget (installer may request UAC)"]
      : []),
  ];
  if (dryRun) return { actions, installed: false };
  if (missingVault && !tools("winget"))
    throw new HomectlError(
      5,
      "Install Microsoft App Installer (winget), or install KeePassXC from https://keepassxc.org/download, then retry setup --install-deps",
    );
  if (missingSSH) {
    const inner = `$ErrorActionPreference='Stop';try{Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null;exit 0}catch{exit 1}`;
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    const outer = `$ErrorActionPreference='Stop';try{$p=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Verb RunAs -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Wait -PassThru;exit $p.ExitCode}catch{exit 1}`;
    const result = await runner({
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(interactive ? outer : inner, "utf16le").toString("base64"),
      ],
      timeoutMs: 900_000,
    });
    if (result.exitCode)
      throw new HomectlError(
        5,
        "OpenSSH Client installation failed or UAC was cancelled; retry setup --install-deps or enable OpenSSH Client in Windows Optional features",
      );
  }
  if (missingVault && !interactive) {
    const admin = await runner({
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 0}else{exit 1}",
      ],
    });
    if (admin.exitCode)
      throw new HomectlError(
        5,
        "JSON dependency installation requires an elevated terminal; no UAC prompt will be opened",
      );
  }
  if (missingVault) {
    const result = await runner({
      argv: [
        "winget",
        "install",
        "--id",
        "KeePassXCTeam.KeePassXC",
        "--exact",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      timeoutMs: 900_000,
    });
    if (result.exitCode)
      throw new HomectlError(
        5,
        "KeePassXC installation failed; run winget install --id KeePassXCTeam.KeePassXC --exact in your terminal to inspect the error",
      );
  }
  const checks = ["ssh", "keepassxc-cli"].map((name) => ({
    name,
    ok: tools(name),
  }));
  if (checks.some((check) => !check.ok))
    throw new HomectlError(
      5,
      "Dependencies remain unavailable after installation; check OpenSSH Client and KeePassXC installation, then retry setup --install-deps",
    );
  return { actions, installed: actions.length > 0, checks };
}

export async function installLinuxDependencies(
  dryRun: boolean,
  interactive: boolean,
) {
  const missing = [
    ...(!available("ssh") ? ["openssh"] : []),
    ...(!available("keepassxc-cli") ? ["keepassxc"] : []),
  ];
  if (!missing.length) return { installed: false, actions: [] };
  let commands: string[][];
  if (Bun.which("apt-get"))
    commands = [
      ["apt-get", "update"],
      [
        "apt-get",
        "install",
        "-y",
        ...missing.map((name) =>
          name === "openssh" ? "openssh-client" : name,
        ),
      ],
    ];
  else if (Bun.which("dnf"))
    commands = [
      [
        "dnf",
        "install",
        "-y",
        ...missing.map((name) =>
          name === "openssh" ? "openssh-clients" : name,
        ),
      ],
    ];
  else if (Bun.which("pacman"))
    commands = [["pacman", "-S", "--needed", "--noconfirm", ...missing]];
  else
    throw new HomectlError(
      5,
      "Unsupported package manager; install OpenSSH and KeePassXC manually",
    );
  if (dryRun)
    return {
      installed: false,
      actions: commands.map((argv) => argv.join(" ")),
    };
  for (const command of commands) await privileged(command, interactive);
  if (!available("ssh") || !available("keepassxc-cli"))
    throw new HomectlError(
      5,
      "Dependencies unavailable after package installation",
    );
  return { installed: true, actions: ["OpenSSH and KeePassXC installed"] };
}
