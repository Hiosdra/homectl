import type { Page } from "./help-format";

export const commandsHelp: Page = {
  usage: "home-ctl commands <list|save|run|rm> [id] [options]",
  intro:
    "Saved commands are shortcuts only. Every run is checked against this device's current host inventory and execution policy; approvals and parameter values are never saved.",
  sections: [
    {
      title: "Actions",
      rows: [
        [
          "list",
          "List saved templates. Synced templates can name hosts unavailable on this device.",
        ],
        [
          "save --file PATH",
          "Save a JSON object with name, hosts, argv, optional parameters and description. Use --id to edit.",
        ],
        [
          "run <id-or-name>",
          "Run the template through normal policy; use --target when it has multiple hosts.",
        ],
        ["rm <id-or-name>", "Remove one template by id or unique name."],
      ],
    },
    {
      title: "Run options",
      rows: [
        ["--target HOST", "Select one of the saved template's hosts."],
        [
          "--parameters-file PATH",
          "JSON object of parameter name/value strings; values are used only for this run.",
        ],
        [
          "-- name=value",
          "Provide declared parameter values after the separator.",
        ],
      ],
    },
    {
      title: "Template example",
      rows: [
        [
          "Save JSON",
          '{"name":"Service status","hosts":["nas"],"argv":["systemctl","status","{{unit}}"],"parameters":[{"name":"unit"}]}',
        ],
      ],
    },
  ],
};

export const historyHelp: Page = {
  usage: "home-ctl history clear [--inventory PATH] [--json]",
  intro:
    "Permanently clear this device's separate ordinary-command history. This does not change the control-plane audit journal.",
  sections: [
    {
      title: "Actions",
      rows: [["clear", "Remove retained local command-history entries."]],
    },
    {
      title: "Options",
      rows: [
        ["--inventory PATH", "Use another inventory file."],
        ["--json", "Print machine-readable output."],
        ["--dry-run", "Preview without changes or credential access."],
        ["-h, --help", "Show help for this command."],
      ],
    },
  ],
};
