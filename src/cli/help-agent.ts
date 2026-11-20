// 0.3 help pages for agents and approvals. They match the parser in broker-commands.ts.
import { AUTO_MODE_ROWS } from "./help-broker";
import { globalOptions, type Page, type Section } from "./help-format";

const exitCodes: Section = {
  title: "Exit codes for wait and op",
  rows: [
    ["0", "Succeeded."],
    ["3", "Denied, cancelled or expired."],
    ["4", "Still waiting for the owner's approval."],
    ["5", "Failed before it ran, or the state is unknown."],
    ["6", "The command ran and failed; its output is shown."],
  ],
};

export const agentHelp: Record<string, Page> = {
  approvals: {
    usage: "home-ctl approvals [--json]",
    intro:
      "Lists operations waiting for the owner's decision. Asks for the owner password privately. Agents cannot approve; only the owner's decision counts.",
    sections: [globalOptions],
  },
  approve: {
    usage: "home-ctl approve <operation> [--remember]",
    intro:
      "Approves one waiting operation. The owner approves in the owner panel or with this command. Asks for the owner password privately. --approval was removed in 0.3.0.",
    sections: [
      {
        title: "Command options",
        rows: [
          [
            "--remember",
            "Records the approve-remember decision instead of approve-once.",
          ],
        ],
      },
      globalOptions,
    ],
  },
  deny: {
    usage: "home-ctl deny <operation> [--remember]",
    intro:
      "Denies one waiting operation. Asks for the owner password privately.",
    sections: [
      {
        title: "Command options",
        rows: [
          [
            "--remember",
            "Records the deny-remember decision instead of deny-once.",
          ],
        ],
      },
      globalOptions,
    ],
  },
  wait: {
    usage: "home-ctl wait <operation> [--wait SECONDS]",
    intro:
      "Waits for the owner's decision and the result. Use it after exec returns awaiting-approval. Waiting never resubmits the operation.",
    sections: [
      {
        title: "Command options",
        rows: [["--wait SECONDS", "How long to wait, 0 to 600 (default 120)."]],
      },
      exitCodes,
      globalOptions,
    ],
  },
  op: {
    usage: "home-ctl op <operation>",
    intro: "Shows an operation's current state now, without waiting.",
    sections: [exitCodes, globalOptions],
  },
  cancel: {
    usage: "home-ctl cancel <operation>",
    intro:
      "Cancels an operation that is still awaiting approval. An operation that the owner already decided cannot be cancelled.",
    sections: [globalOptions],
  },
  task: {
    usage: 'home-ctl task open "<title>" [--ttl MINUTES] | task close <id>',
    intro:
      "A task groups operations under one title, so the owner sees them together. Pass its id to exec with --task.",
    sections: [
      {
        title: "Actions",
        rows: [
          ['open "<title>"', "Opens a task and prints its id."],
          ["--ttl MINUTES", "How long the task stays open."],
          ["close <id>", "Closes the task."],
        ],
      },
      globalOptions,
    ],
  },
  agent: {
    usage:
      "home-ctl agent list | connect codex|claude|other --hosts a,b [--name NAME] | rotate <id> | revoke <id>",
    intro:
      "Owner commands for agent clients. Each one asks for the owner password privately.",
    sections: [
      {
        title: "Actions",
        rows: [
          ["list", "Lists agent clients."],
          [
            "connect codex|claude|other --hosts a,b",
            "Creates a client that can reach only the listed hosts. Shows the change to the agent's configuration and applies it after you answer y. The token is stored privately, not printed.",
          ],
          [
            "--name NAME",
            "Client id; defaults to the agent kind and this computer's name.",
          ],
          [
            "rotate <id>",
            "Replaces the client's token. The new token is stored for this device's agent.",
          ],
          ["revoke <id>", "Revokes the client. Its token stops working."],
        ],
      },
      { title: "Reviewer and Auto Mode", rows: AUTO_MODE_ROWS },
      globalOptions,
    ],
  },
  mcp: {
    usage: "home-ctl mcp",
    intro:
      "Runs the MCP stdio server for an agent on this device. Stdout carries protocol messages only. It uses the agent's client token and the running broker. agent connect writes the agent configuration that starts it.",
    sections: [globalOptions],
  },
};
