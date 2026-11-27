// 0.3 help pages: the broker daemon, owner host commands, workspace and migrate.
// Each page matches the parser in broker-commands.ts, daemon-command.ts,
// workspace-commands.ts, host-permissions.ts (ownerHostCommand) and migrate-command.ts.
import { globalOptions, type Page, type Section } from "./help-format";

// Backup request and restore rows of the workspace page (Status section).
export const WORKSPACE_RESTORE_ROWS: [string, string][] = [
  [
    "request-backup <client>",
    "Asks a linked client to back up at its next sync (within 5 seconds while it is online).",
  ],
  [
    "restore-preview <client> [seq] --reason <text>",
    "Checks a stored snapshot without changing anything: whether it verifies, and which files a restore would write. seq defaults to the latest. Asks for the owner password. The reason is 1 to 300 characters and is audited.",
  ],
  [
    "restore <client> <seq> --reason <text>",
    "Restores snapshot seq after it verifies. Asks for the owner password and the reason, and revokes the client. It prints a code for a fresh device: run `workspace join <server> <code>` there before the code expires. Only inventory.yaml, known_hosts and policy.json come back; they are written only to a device that has none of them, and the revocations the client reported are reapplied.",
  ],
];

// Reviewer and Auto Mode rows, shown on the agent page (help-agent.ts). Each
// command asks for the owner password privately.
export const AUTO_MODE_ROWS: [string, string][] = [
  [
    "owner auto-mode [get]",
    "Shows the Auto Mode mode, reviewer authority, endpoint, model and where the AI helper key comes from. The key itself is never shown.",
  ],
  [
    "owner auto-mode set-key",
    "Saves the AI helper's API key in the encrypted vault. Asks for the owner password, then prompts for the key privately. The key is never an argument.",
  ],
  [
    "owner auto-mode set [--mode manual|rules|auto] [--authority recommend|routine|delegated] [--endpoint <url>|none] [--model <name>]",
    "Changes Auto Mode. Give at least one option. The broker checks the password again when a change raises the authority, turns Auto on or sets a new endpoint. --endpoint none removes the endpoint. Authority: recommend (default) only recommends; routine lets the reviewer allow routine R1-R2 requests that no rule covers; delegated is wider, and R3, R4 and human-only actions still need you.",
  ],
];

const ownerPasswordNote =
  "Asks for the owner password privately on every run; it is never an argument.";

const daemonSections: Section[] = [
  {
    title: "Actions",
    rows: [
      [
        "run",
        "Starts the broker in the foreground and migrates the workspace first. Hardened mode also starts the owner panel. Ctrl+C stops both. Compat (default) keeps state in the workspace's broker folder under your own OS user; any process of that user can read it.",
      ],
      [
        "panel",
        "Starts the owner web panel on 127.0.0.1 by default (HOMECTL_OWNER_PANEL_PORT, default 7451; HOMECTL_PANEL_LISTEN for another address). It proxies to a running broker, which must have been started with the same origin in HOMECTL_PANEL_ORIGIN.",
      ],
      [
        "status",
        "Reports whether the broker answers, its mode, and the owner panel URL when configured.",
      ],
      [
        "install",
        "Installs the hardened service. When no owner password is set, asks for one (twice), then for the reviewer authority: recommend (default), routine or delegated, the same choice as owner init. Use --dry-run first to see the steps, or the reasons when this platform is not supported.",
      ],
      ["uninstall", "Removes the hardened service. Same --dry-run preview."],
    ],
  },
  {
    title: "Environment",
    rows: [
      [
        "HOMECTL_WORKSPACE_LISTEN=HOST:PORT",
        "Makes this broker a workspace server: it also serves the pairing and sync endpoints on that address, for example 0.0.0.0:7450. Only those endpoints; every message after pairing is sealed. Without it the broker is a client only.",
      ],
      [
        "HOMECTL_PANEL_ORIGIN=ORIGIN",
        "Exact origin of the owner panel (for example http://127.0.0.1:7451). The broker accepts only that origin and links approvals to it. Required when HOMECTL_PANEL_LISTEN is not loopback: give the exact browser origin, for example https://homectl.lan.example.test.",
      ],
      [
        "HOMECTL_PANEL_LISTEN=IP",
        "Address daemon panel listens on: an IP address, not a name. Default 127.0.0.1. Another address (for example 0.0.0.0) needs HOMECTL_PANEL_ORIGIN and prints a warning. Put it behind an https reverse proxy you run, or a firewall that admits only your LAN or VPN.",
      ],
      [
        "HOMECTL_PANEL_INSECURE_HTTP=1",
        "Lets a non-loopback panel use an http:// origin. Without it that combination is refused. Plain http sends the owner password and session cookie across the LAN unencrypted; prefer an https reverse proxy or an SSH tunnel to 127.0.0.1.",
      ],
      ["HOMECTL_OWNER_PANEL_PORT=PORT", "Port for daemon panel. Default 7451."],
      [
        "HOMECTL_WORKSPACE_QUOTA_MB=MIB",
        "Backup storage limit per linked client, in whole MiB: 1 to 1048576, default 1024. Read only on a workspace server (with HOMECTL_WORKSPACE_LISTEN).",
      ],
      [
        "HOMECTL_REVIEWER_API_KEY=KEY",
        "API key for the Auto Mode reviewer endpoint. The daemon reads it from its environment on each reviewer call. Set it only in the environment: homectl never writes it to a file, the policy, a log or the panel.",
      ],
    ],
  },
  {
    title: "Examples",
    rows: [
      [
        "HOMECTL_WORKSPACE_LISTEN=0.0.0.0:7450 home-ctl daemon run",
        "Run a workspace server that accepts client pairing on port 7450.",
      ],
      [
        "home-ctl daemon install --dry-run",
        "Preview the hardened service steps without installing anything. --dry-run applies to install and uninstall only.",
      ],
    ],
  },
  globalOptions,
];

const ownerSections: Section[] = [
  {
    title: "Actions",
    rows: [
      [
        "init",
        "Sets the owner password for compat mode (asked twice, privately), then asks for the reviewer authority: recommend (default, Enter keeps it), routine or delegated. Refused when a vault already holds the owner password or one is already set.",
      ],
      [
        "auto-mode [get]",
        "Shows Auto Mode settings. auto-mode set changes them; see Reviewer and Auto Mode on the agent page (home-ctl agent --help).",
      ],
      [
        "scan-host-keys <host>",
        "Reads the SSH host keys the inventory host presents. Unverified: nothing is trusted from a scan.",
      ],
      [
        "pin-host-key <host> <SHA256:…>",
        "Pins the presented key with that fingerprint. Confirm the fingerprint out of band first (console or provider). Refuses revoked keys and a second key for the same address.",
      ],
      [
        "inspect-host <host>",
        "Reads the host's platform and what homectl could manage there, through the pinned key.",
      ],
      [
        "proxmox-api <host> <https-origin> <vault-entry> [fingerprint]",
        "Previews full Proxmox HTTPS setup using the cluster CA read over pinned SSH and an existing token in the broker vault. Pass the reviewed fingerprint to verify and save. Asks for the owner password privately.",
      ],
      [
        "preview-host-grant <host>",
        "Plans the homectl sudoers drop-in for the host and prints its fingerprint. Writes nothing on the host.",
      ],
      [
        "apply-host-grant <host> <fingerprint>",
        "Writes the previewed drop-in. The fingerprint is the 64 hex characters from preview-host-grant; a changed plan is refused. Backup, validation and verification run on the host.",
      ],
      [
        "revoke-host-grant <host>",
        "Removes only homectl's drop-in from the host. Other sudo rules are not touched.",
      ],
      [
        "repair-host-grant <host> [fingerprint]",
        "Repairs homectl's own drop-in when it has drifted from the plan. Without a fingerprint it previews the diff and prints a fingerprint, or reports that nothing changed. With the reviewed fingerprint it applies only if the drop-in still matches: visudo checks the new file, it is swapped in atomically, and the old content returns if a check fails. It never creates a missing drop-in and never touches a file without homectl's header.",
      ],
    ],
  },
  {
    title: "Notes",
    rows: [
      [
        "Owner password",
        `${ownerPasswordNote} The host commands need a running broker (daemon run).`,
      ],
      [
        "Order",
        "pin-host-key before inspect, preview, apply, revoke or repair. Apply or repair only what preview showed.",
      ],
    ],
  },
  globalOptions,
];

const workspaceSections: Section[] = [
  {
    title: "Server",
    rows: [
      [
        "invite",
        "Creates a pairing code valid for 5 minutes and one attempt. A wrong code closes the invite.",
      ],
      [
        "clients",
        "Lists linked clients with their remote-approval setting, stale marker and pending count.",
      ],
      [
        "pending",
        "Lists operations waiting on linked clients, with the fingerprint each decision needs.",
      ],
      [
        "intents [client]",
        "Lists the decisions you sent from this server, newest first, with their status: queued, delivered, applied or refused (with the client's reason). An optional client id narrows the list.",
      ],
      [
        "decide <client> <operationId> <fingerprint> approve|deny",
        "Queues your decision for one client's pending operation. The client applies it at its next sync, through its own policy. A stale fingerprint is refused.",
      ],
      [
        "remove <client>",
        "Removes a client. It cannot rejoin with the same identity. Asks for the owner password.",
      ],
      [
        "retired [client]",
        "Lists removed clients whose mirrored events are kept. With a client id, prints that record as JSON.",
      ],
    ],
  },
  {
    title: "Client",
    rows: [
      [
        "join <address> <code> [--remote-approval]",
        "Links this broker to the server with the code from invite, and prints a verification phrase to compare on both devices. --remote-approval lets the server owner approve this client's ordinary operations. Operations that need step-up are never approved remotely.",
      ],
      ["leave", "Leaves the server. Local operation continues unchanged."],
    ],
  },
  {
    title: "Status",
    rows: [
      ["status", "Prints the link state as JSON."],
      ["sync-now", "Requests a sync now. Prints the result as JSON."],
      [
        "backup-now",
        "Takes an encrypted backup now. Prints the result as JSON.",
      ],
      ...WORKSPACE_RESTORE_ROWS,
    ],
  },
  {
    title: "Notes",
    rows: [
      [
        "Owner password",
        `${ownerPasswordNote} Every workspace command asks for it.`,
      ],
      [
        "Server",
        "Start it with HOMECTL_WORKSPACE_LISTEN (see daemon run). Clients work without a server.",
      ],
    ],
  },
  globalOptions,
];

const migrateSections: Section[] = [
  {
    title: "Options",
    rows: [
      [
        "--dry-run",
        "Lists the migration steps that would run and changes nothing.",
      ],
      [
        "--mode compat|hardened",
        "compat (default) migrates the workspace beside the inventory, as daemon run does. hardened migrates the service state that daemon run --mode hardened starts from; it is owned by the service account, so run it as an administrator. Hardened ignores --inventory.",
      ],
      ["--inventory PATH", "Use another inventory file."],
      ["--json", "Print machine-readable output."],
    ],
  },
];

const proxmoxSections: Section[] = [
  {
    title: "Guest actions",
    rows: [
      [
        "proxmox <host> list|status|config|start|stop|reboot|shutdown|clone|create|destroy [--kind qemu|lxc] [--vmid N] ...",
        "Plans one guest action on the provider's node: a typed catalogue action with its own checks (VMID range, protected VMIDs, storages, templates). Start, stop and reboot need the owner's approval in Needs you. Destroy and other destructive actions need the owner's password. Restore is disabled.",
      ],
    ],
  },
  {
    title: "Full API",
    rows: [
      [
        "proxmox <host> api GET|POST|PUT|DELETE <path> [--param key=value ...]",
        "Plans one Proxmox API call from homectl's route table. Reads run without approval. Changes need the owner's approval; deletes and rollbacks are destructive. Owner-only areas (users and permissions, firewall, network, HA, cluster settings, node power, command execution, guest agent) need the owner's password and no rule or assistant can approve them. Needs operations: full on the provider, and an api block.",
      ],
    ],
  },
  {
    title: "Options",
    rows: [
      [
        "--wait <seconds>",
        "How long to wait for the owner's decision (default 120, up to 600).",
      ],
      ["--task <id>", "Ties the request to an open task."],
      ["--json", "Prints the operation view as JSON."],
    ],
  },
];

export const brokerHelp: Record<string, Page> = {
  proxmox: {
    usage:
      "home-ctl proxmox <host> <action> [options] | home-ctl proxmox <host> api <GET|POST|PUT|DELETE> <path> [--param key=value ...]",
    intro:
      "Asks the broker to plan a Proxmox change as this agent client. Nothing runs until the owner approves it in Needs you (or with home-ctl approve). Refused requests are not queued. The provider and its api block are set in the inventory.",
    sections: proxmoxSections,
  },
  daemon: {
    usage:
      "home-ctl daemon run|panel|status|install|uninstall [--mode compat|hardened]",
    intro:
      "The broker holds approvals, vault and operation state. Agents reach it with their client token; the owner approves with the owner password.",
    sections: daemonSections,
  },
  owner: {
    usage:
      "home-ctl owner init | auto-mode [get] | auto-mode set [--mode manual|rules|auto] [--authority recommend|routine|delegated] [--endpoint <url>|none] [--model <name>] | auto-mode set-key | scan-host-keys <host> | pin-host-key <host> <SHA256:…> | inspect-host <host> | preview-host-grant <host> | apply-host-grant <host> <fingerprint> | revoke-host-grant <host> | repair-host-grant <host> [fingerprint]",
    intro:
      "Owner commands for the broker's inventory and host trust. Each one asks for the owner password privately. Host commands need a running broker.",
    sections: ownerSections,
  },
  workspace: {
    usage:
      "home-ctl workspace invite | join <address> <code> [--remote-approval] | status | clients | pending | intents [client] | decide <client> <operationId> <fingerprint> approve|deny | remove <client> | retired [client] | leave | sync-now | backup-now | request-backup <client> | restore-preview <client> [seq] --reason <text> | restore <client> <seq> --reason <text>",
    intro:
      "Connects brokers. One broker can be the server; the others are clients. A client keeps working without the server.",
    sections: workspaceSections,
  },
  migrate: {
    usage:
      "home-ctl migrate [--dry-run] [--mode compat|hardened] [--inventory PATH] [--json]",
    intro:
      "Upgrades workspace data to the current version. The broker runs the same migration when it starts, so this command is for a preview or for an upgrade before the daemon starts. --dry-run lists the steps that would run and the files each one may touch; it changes nothing. A run locks the workspace, backs up each file the steps may touch into the workspace's backups folder, runs and verifies each step in order, and checks that no other file changed. The version marker is written last. If anything fails, the backup is restored and the workspace stays at its old version; an interrupted run is rolled back before the next one starts. Open 0.2 approvals are closed and must be planned again. Running it on current data changes nothing.",
    sections: migrateSections,
  },
};
