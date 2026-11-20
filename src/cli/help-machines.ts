// Help pages for session, keys, machines and enrollment.
import { globalOptions, type Page } from "./help-format";

export const machineHelp: Record<string, Page> = {
  session: {
    usage: "home-ctl session <action> [options]",
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
            "home-ctl session configure --ttl 24h",
            "Set a daily unlock interval.",
          ],
          [
            "home-ctl session configure --ttl until-reboot",
            "Keep keys until lock or cold reboot.",
          ],
          ["home-ctl session unlock", "Run yourself in a private terminal."],
          ["home-ctl session status --json", "Inspect the current session."],
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
    usage: "home-ctl key <create|inspect> <name> [options]",
    sections: [
      {
        title: "Actions",
        rows: [
          [
            "create <name>",
            "Privately create or reuse a KDBX key and load it into the managed agent. Uses encrypted staging on all platforms.",
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
    usage: "home-ctl exec <host> [options] -- <command> [args...]",
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
            "--task ID",
            "Attach the command to an open task (task open). Needs the broker.",
          ],
          [
            "--wait SECONDS",
            "How long this call waits for the owner's decision and the result, 0 to 600 (default 120). A timeout does not resubmit the command; use wait or op to check it.",
          ],
        ],
      },
      globalOptions,
      {
        title: "Examples",
        rows: [
          ["home-ctl exec voron -- uname -s", "Inspect the host OS."],
          ["home-ctl exec voron --dry-run -- uptime", "Preview the command."],
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
    usage: "home-ctl enroll <host> --file PATH [options]",
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
    usage: "home-ctl provision --file PATH [options]",
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
// `ssh` is an alias for `exec`: same page, different usage line.
machineHelp.ssh = {
  ...(machineHelp.exec as Page),
  usage: "home-ctl ssh <host> [options] -- <command> [args...]",
};
