// Help registry for `home-ctl <command> --help` and `home-ctl help [topic]`.
// The pages live in help-*.ts modules; this file holds the root page, the
// short command pages and the lookup.
import { agentHelp } from "./help-agent";
import { brokerHelp } from "./help-broker";
import { controlHelp } from "./help-control";
import { machineHelp } from "./help-machines";
import { formatPage, globalOptions, type Page } from "./help-format";
import { serveHelp } from "./help-serve";
import { commandsHelp, historyHelp } from "./commands-help";
import { peerHelp } from "./peer-help";

export type { Page } from "./help-format";

const pages: Record<string, Page> = {
  "": {
    usage: "home-ctl <command> [options]",
    intro: "Manage your homelab through the homectl broker, SSH and KeePassXC.",
    sections: [
      {
        title: "Get started",
        rows: [
          [
            "update",
            "Update the checkout, dependencies and local installation.",
          ],
          ["setup", "Install the CLI links, skills and SSH configuration."],
          [
            "migrate [--dry-run] [--mode compat|hardened]",
            "Upgrade workspace data to the current version. The broker also does this on start.",
          ],
          [
            "serve",
            "Run the local panel, LAN pairing and peer synchronization.",
          ],
          [
            "panel",
            "Open the panel privately without exposing its access token.",
          ],
          ["service <action>", "Install or manage persistent serve execution."],
          ["doctor [host]", "Check tools and, optionally, host access."],
        ],
      },
      {
        title: "Broker and workspace",
        rows: [
          [
            "daemon run|panel|status|install|uninstall",
            "Run the broker, its owner panel, or manage the hardened service.",
          ],
          [
            "owner <action>",
            "Owner password, host key pinning and host sudo grants.",
          ],
          [
            "workspace <action>",
            "Link brokers: invite, join, decide, and manage clients.",
          ],
        ],
      },
      {
        title: "Agents and approvals",
        rows: [
          ["agent <action>", "Connect, list, rotate or revoke agent clients."],
          ["approvals", "List operations waiting for the owner's decision."],
          ["approve | deny <operation>", "Owner decision for one operation."],
          ["wait | op <operation>", "Wait for, or check, an operation."],
          [
            "cancel <operation>",
            "Cancel an operation still awaiting approval.",
          ],
          ["task open | close", "Group operations under one title."],
          ["mcp", "Run the MCP stdio server for an agent on this device."],
        ],
      },
      {
        title: "Peer workspace",
        rows: [
          ["peers", "List paired devices without secrets."],
          [
            "pair [action]",
            "Pair privately with a code and confirmation on both devices.",
          ],
          [
            "sync <action> <id>",
            "Preview, resolve and apply bidirectional changes.",
          ],
          [
            "peer <id> --target HOST",
            "Run an operation through a granted peer.",
          ],
        ],
      },
      {
        title: "Session and keys",
        rows: [
          [
            "session <action>",
            "Configure, initialize, unlock, inspect or lock.",
          ],
          [
            "key create <name>",
            "Create or reload a key privately in KeePassXC.",
          ],
          [
            "key inspect <name>",
            "Show the public key and inventory references.",
          ],
        ],
      },
      {
        title: "Machines",
        rows: [
          ["hosts", "List configured machines."],
          ["inspect <host>", "Show purpose, access tier and cautions."],
          ["exec <host> -- <argv...>", "Run a command under host policy."],
          ["ssh <host> -- <argv...>", "Alias for exec."],
          ["commands <action>", "Save, list and run saved commands."],
          ["history clear", "Delete this device's local command history."],
          ["enroll <host> --file PATH", "Add an existing machine."],
          ["sudoers <host>", "Print the host's sudo policy."],
          ["provision --file PATH", "Create and enroll a Proxmox VM over SSH."],
        ],
      },
      {
        title: "Control plane",
        rows: [
          [
            "serve-mcp",
            "Run the loopback MCP endpoint for scoped, token-authenticated clients.",
          ],
          [
            "control <action>",
            "Manage clients, execute approved operations and verify the audit journal.",
          ],
        ],
      },
      globalOptions,
      {
        title: "Examples",
        rows: [
          [
            "home-ctl daemon --help",
            "Broker run, owner panel and workspace variables.",
          ],
          [
            "home-ctl workspace --help",
            "Link brokers and manage linked clients.",
          ],
          ["home-ctl exec --help", "Command execution and confirmation."],
          ["home-ctl doctor voron", "Check a configured host."],
        ],
      },
    ],
  },
  update: {
    usage: "home-ctl update [--dry-run] [--rollback] [--json]",
    intro:
      "Source checkout: fast-forward the current branch from its configured upstream, install the frozen dependencies and refresh setup. Git refuses overlapping local changes or divergent history; no automatic stash or reset; never restarts services. Release build: --rollback points the command files back at the release that ran before the last install (the previous release stays on disk). A release install verifies the signed manifest and refuses unsigned, wrongly signed, wrong-platform and older releases.",
    sections: [{ ...globalOptions }],
  },
  setup: {
    usage:
      "home-ctl setup [--json] [--dry-run] [--install-deps] [--configure-firewall --interface IP]",
    intro:
      "Interactive setup guides dependency installation, LAN selection and scoped firewall configuration with confirmation. Installs per-user CLI, skills and SSH configuration. --json never prompts: use --install-deps and --configure-firewall --interface IP explicitly from an administrator terminal. --dry-run previews without changing files or firewall rules. Existing configuration is preserved. Uses the standard per-user directory; --inventory is not supported.",
    sections: [
      {
        ...globalOptions,
        rows: globalOptions.rows.filter(
          ([label]) => label !== "--inventory PATH",
        ),
      },
    ],
  },
  doctor: {
    usage: "home-ctl doctor [host] [options]",
    intro:
      "Check local tools. A named host adds a real managed-key SSH probe. Never opens KDBX or restarts services.",
    sections: [{ ...globalOptions }],
  },
  hosts: {
    usage: "home-ctl hosts [options]",
    intro: "List machines from inventory.",
    sections: [{ ...globalOptions }],
  },
  inspect: {
    usage: "home-ctl inspect <host> [options]",
    intro: "Show the host's purpose, cautions, account and access tier.",
    sections: [{ ...globalOptions }],
  },
  sudoers: {
    usage: "home-ctl sudoers <host> [options]",
    intro: "Print literal sudoers rules without installing them.",
    sections: [{ ...globalOptions }],
  },
  ...machineHelp,
  ...serveHelp,
  ...controlHelp,
  ...brokerHelp,
  ...agentHelp,
  peer: peerHelp,
  commands: commandsHelp,
  history: historyHelp,
};

export const helpTopics = Object.keys(pages);

export function renderHelp(
  topic = "",
  options: { width?: number; color?: boolean } = {},
) {
  const page = pages[topic] ?? (pages[""] as Page);
  return formatPage(page, topic, options);
}
