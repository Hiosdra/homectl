// Hardened broker installation plans (homelab #21 §3: isolated credential
// broker by default). The plan is shown to the owner before anything runs and
// every step is an argv (no shell). Installing needs OS administrator rights
// once; afterwards the agent's user cannot read broker state, keys or the
// vault, and cannot reach credentials except through the token-checked API.
import { join } from "node:path";
import { HomectlError } from "../types";
import { hardenedPaths } from "./paths";

export const SERVICE_USER = "homectl";
export const UNIT_PATH = "/etc/systemd/system/homectl.service";

export interface InstallStep {
  description: string;
  argv: string[];
  stdin?: string;
  // A failing check step means "already done"; the step is skipped.
  skipIf?: string[];
}

export interface InstallPlan {
  platform: NodeJS.Platform;
  supported: boolean;
  reasons: string[];
  steps: InstallStep[];
  // Data copied from the owner's workspace into broker custody.
  imports: string[];
}

export function systemdUnit(executable: string[]): string {
  const paths = hardenedPaths("linux");
  return `[Unit]
Description=homectl broker (agent access and approvals)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${executable.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")} daemon run --mode hardened
Restart=on-failure
RestartSec=5
UMask=0077
StateDirectory=homectl
StateDirectoryMode=0700
RuntimeDirectory=homectl
RuntimeDirectoryMode=0755
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=${paths.state}

[Install]
WantedBy=multi-user.target
`;
}

// Workspace files the broker takes into custody (copied, never moved: the
// owner keeps the original until they delete it after checking).
export const CUSTODY_FILES = [
  "inventory.yaml",
  "homelab.kdbx",
  "known_hosts",
  "public-keys",
  "saved-commands.json",
  "control-plane",
  "homectl-data.json",
];

export function linuxPlan(options: {
  executable: string[];
  workspace: string;
}): InstallPlan {
  const state = hardenedPaths("linux").state;
  const workspace = join(state, "workspace");
  const steps: InstallStep[] = [
    {
      description: `Create the ${SERVICE_USER} system account (no login shell, no password)`,
      argv: [
        "useradd",
        "--system",
        "--home-dir",
        state,
        "--no-create-home",
        "--shell",
        "/usr/sbin/nologin",
        SERVICE_USER,
      ],
      skipIf: ["id", "-u", SERVICE_USER],
    },
    {
      description: `Create ${workspace} owned by ${SERVICE_USER}, mode 0700`,
      argv: [
        "install",
        "-d",
        "-m",
        "0700",
        "-o",
        SERVICE_USER,
        "-g",
        SERVICE_USER,
        state,
        workspace,
      ],
    },
    ...CUSTODY_FILES.map((name) => ({
      description: `Copy ${name} into broker custody`,
      argv: [
        "cp",
        "-a",
        "--no-clobber",
        join(options.workspace, name),
        join(workspace, name),
      ],
      skipIf: ["test", "!", "-e", join(options.workspace, name)],
    })),
    {
      description: `Give ${SERVICE_USER} ownership of its workspace`,
      argv: ["chown", "-R", `${SERVICE_USER}:${SERVICE_USER}`, state],
    },
    {
      description: `Write ${UNIT_PATH}`,
      argv: ["install", "-m", "0644", "/dev/stdin", UNIT_PATH],
      stdin: systemdUnit(options.executable),
    },
    { description: "Reload systemd", argv: ["systemctl", "daemon-reload"] },
    {
      description: "Enable and start the broker",
      argv: ["systemctl", "enable", "--now", "homectl.service"],
    },
  ];
  return {
    platform: "linux",
    supported: true,
    reasons: [],
    steps,
    imports: CUSTODY_FILES.map((name) => join(options.workspace, name)),
  };
}

export function installPlan(options: {
  platform: NodeJS.Platform;
  executable: string[];
  workspace: string;
  systemd: boolean;
}): InstallPlan {
  if (options.platform === "linux") {
    if (!options.systemd)
      return {
        platform: "linux",
        supported: false,
        reasons: [
          "systemd is not running here (common in WSL without systemd=true and in containers).",
          "Enable systemd in WSL (/etc/wsl.conf [boot] systemd=true), or run the broker in its container image, or use compatibility mode.",
        ],
        steps: [],
        imports: [],
      };
    return linuxPlan(options);
  }
  return {
    platform: options.platform,
    supported: false,
    reasons: [
      options.platform === "win32"
        ? "The hardened Windows service (virtual service account) is not available in this build yet; compatibility mode runs as your user and is weaker."
        : "The hardened macOS launchd daemon is not available in this build yet; compatibility mode runs as your user and is weaker.",
    ],
    steps: [],
    imports: [],
  };
}

export function uninstallPlan(): InstallStep[] {
  return [
    {
      description: "Stop and disable the broker",
      argv: ["systemctl", "disable", "--now", "homectl.service"],
    },
    { description: `Remove ${UNIT_PATH}`, argv: ["rm", "-f", UNIT_PATH] },
    { description: "Reload systemd", argv: ["systemctl", "daemon-reload"] },
  ];
}

export function assertRoot() {
  if (process.getuid?.() !== 0)
    throw new HomectlError(
      5,
      "Installing the hardened broker needs administrator rights once: run it with sudo",
    );
}
