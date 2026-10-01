type Section = { title: string; rows: [string, string][] };
type Page = { usage: string; intro?: string; sections: Section[] };

const globalOptions: Section = {
  title: "Options",
  rows: [
    ["--inventory PATH", "Use another inventory file."],
    ["--json", "Print machine-readable output."],
    ["--dry-run", "Preview without changes or credential access."],
    ["-h, --help", "Show help for this command."],
  ],
};
const pages: Record<string, Page> = {
  "": {
    usage: "homectl <command> [options]",
    intro: "Manage your homelab through KeePassXC and SSH.",
    sections: [
      {
        title: "Get started",
        rows: [
          ["setup", "Install the CLI links, skills and SSH configuration."],
          ["doctor [host]", "Check tools and, optionally, host access."],
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
          [
            "exec <host> -- <argv...>",
            "Run a command under the host's access policy.",
          ],
          ["ssh <host> -- <argv...>", "Alias for exec."],
          ["enroll <host> --file PATH", "Add an existing machine."],
          ["sudoers <host>", "Print the host's sudo policy."],
          ["provision --file PATH", "Create and enroll a Proxmox VM over SSH."],
        ],
      },
      globalOptions,
      {
        title: "Examples",
        rows: [
          ["homectl session --help", "Session actions and TTL options."],
          ["homectl exec --help", "Command execution and confirmation."],
          ["homectl doctor voron", "Check a configured host."],
        ],
      },
    ],
  },
  session: {
    usage: "homectl session <action> [options]",
    intro: "Unlock privately once per TTL or agent-host reboot.",
    sections: [
      {
        title: "Actions",
        rows: [
          [
            "configure",
            "Set the lifetime or database path; locks the session.",
          ],
          ["init", "Create a new encrypted database in a private terminal."],
          ["unlock", "Load enrolled SSH keys; enter the password privately."],
          ["status", "Show whether the session is unlocked and its expiry."],
          ["lock", "Clear only the dedicated homelab SSH agent."],
        ],
      },
      {
        title: "Configure options",
        rows: [
          [
            "--ttl DURATION",
            "Default: 24h. Accepts 1s to 365d, or until-reboot.",
          ],
          ["--database PATH", "Absolute path to the homelab .kdbx database."],
        ],
      },
      globalOptions,
      {
        title: "Examples",
        rows: [
          [
            "homectl session configure --ttl 24h",
            "Set a daily unlock interval.",
          ],
          [
            "homectl session configure --ttl until-reboot",
            "Keep keys until lock or cold reboot.",
          ],
          ["homectl session unlock", "Run yourself in a private terminal."],
          ["homectl session status --json", "Inspect the current session."],
        ],
      },
      {
        title: "Lifetime",
        rows: [
          ["Absolute TTL", "Repeated unlock keeps the existing expiry."],
          [
            "Lock or expiry",
            "Stops new authentication; existing SSH connections can continue.",
          ],
        ],
      },
    ],
  },
  key: {
    usage: "homectl key <create|inspect> <name> [options]",
    sections: [
      {
        title: "Actions",
        rows: [
          [
            "create <name>",
            "Privately create or reuse a KDBX key and load it into the managed agent. Requires Linux tmpfs.",
          ],
          [
            "inspect <name>",
            "Show the public key and auth references without opening KDBX.",
          ],
        ],
      },
      globalOptions,
      {
        title: "Next steps",
        rows: [
          [
            "Install the public key",
            "Use existing trusted access; verify the host fingerprint first.",
          ],
          [
            "Enroll the host",
            "Copy the returned auth references into its host JSON.",
          ],
        ],
      },
    ],
  },
  exec: {
    usage: "homectl exec <host> [options] -- <command> [args...]",
    intro:
      "Put homectl options before --; arguments after it belong to the remote command.",
    sections: [
      {
        title: "Command options",
        rows: [
          [
            "--impact TEXT",
            "Describe concrete targets and effects for review.",
          ],
          [
            "--approval DIGEST",
            "Use the exact plan digest after human confirmation.",
          ],
        ],
      },
      globalOptions,
      {
        title: "Examples",
        rows: [
          ["homectl exec voron -- uname -s", "Inspect the host OS."],
          ["homectl exec voron --dry-run -- uptime", "Preview the command."],
        ],
      },
      {
        title: "Confirmation",
        rows: [
          [
            "Destructive or opaque commands",
            "Review --dry-run and --impact first. Confirm the exact host, argv and effect before passing the digest. There is no --yes bypass.",
          ],
          ["ssh", "Uses the same policy as exec; not an interactive shell."],
        ],
      },
    ],
  },
  enroll: {
    usage: "homectl enroll <host> --file PATH [options]",
    sections: [
      {
        title: "Enrollment",
        rows: [
          [
            "--file PATH",
            "Host JSON with an existing account and managed key references.",
          ],
          [
            "--configure-sudo",
            "Install the requested sudo policy using existing administrator access.",
          ],
          [
            "Before enrollment",
            "Prepare the key privately, install its public key and verify the SSH fingerprint. See README.",
          ],
        ],
      },
      globalOptions,
    ],
  },
  provision: {
    usage: "homectl provision --file PATH [options]",
    sections: [
      {
        title: "Provisioning",
        rows: [
          [
            "--file PATH",
            "VM JSON: provider, template, VMID, resources, network, user and public key.",
          ],
          [
            "Before applying",
            "Enroll a full Proxmox SSH host and prepare the VM key with key create. Review --dry-run first.",
          ],
          [
            "Resume",
            "Reuse the identical request. Inspect conflicts and retained journals; no automatic destructive rollback.",
          ],
        ],
      },
      globalOptions,
    ],
  },
};
for (const [name, usage, description] of [
  [
    "setup",
    "homectl setup [--dry-run]",
    "Install per-user CLI and skill links plus SSH configuration. Existing configuration is preserved. Uses the standard per-user directory; --inventory is not supported.",
  ],
  [
    "doctor",
    "homectl doctor [host] [options]",
    "Check local tools. A named host adds a real managed-key SSH probe. Never opens KDBX or restarts services.",
  ],
  ["hosts", "homectl hosts [options]", "List machines from inventory."],
  [
    "inspect",
    "homectl inspect <host> [options]",
    "Show the host's purpose, cautions, account and access tier.",
  ],
  [
    "sudoers",
    "homectl sudoers <host> [options]",
    "Print literal sudoers rules without installing them.",
  ],
]) {
  pages[name as string] = {
    usage: usage as string,
    intro: description,
    sections: [
      {
        ...globalOptions,
        rows:
          name === "setup"
            ? globalOptions.rows.filter(
                ([label]) => label !== "--inventory PATH",
              )
            : globalOptions.rows,
      },
    ],
  };
}
pages.ssh = {
  ...(pages.exec as Page),
  usage: "homectl ssh <host> [options] -- <command> [args...]",
};

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = "";
    }
    line += `${line ? " " : ""}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

export function renderHelp(
  topic = "",
  options: { width?: number; color?: boolean } = {},
) {
  const page = pages[topic] ?? (pages[""] as Page);
  const width = Math.max(40, Math.min(options.width ?? 80, 100));
  const heading = (text: string) =>
    options.color ? `\x1b[1;36m${text}\x1b[0m` : text;
  const lines = [heading("homectl"), ""];
  if (page.intro) lines.push(...wrap(page.intro, width), "");
  lines.push(
    heading("Usage"),
    ...wrap(page.usage, width - 2).map((line) => `  ${line}`),
  );
  for (const section of page.sections) {
    lines.push("", heading(section.title));
    const labelWidth = Math.max(...section.rows.map(([label]) => label.length));
    const columns = width >= 72 && labelWidth <= 26;
    for (const [label, description] of section.rows) {
      if (columns) {
        const indent = labelWidth + 4;
        const descriptionLines = wrap(description, width - indent);
        lines.push(
          `  ${label.padEnd(labelWidth)}  ${descriptionLines[0] ?? ""}`,
        );
        lines.push(
          ...descriptionLines
            .slice(1)
            .map((line) => `${" ".repeat(indent)}${line}`),
        );
      } else {
        lines.push(...wrap(label, width - 2).map((line) => `  ${line}`));
        lines.push(
          ...wrap(description, width - 4).map((line) => `    ${line}`),
        );
      }
    }
  }
  lines.push("", "More help: homectl <command> --help");
  if (!topic)
    lines.push(
      "Exit codes: 0 success, 2 input, 3 policy, 4 confirmation,",
      "            5 transport/setup, 6 remote command failure.",
    );
  return `${lines.join("\n")}\n`;
}
