import type { Page } from "./help";

const globalOptions: Page["sections"][number] = {
  title: "Options",
  rows: [
    ["--inventory PATH", "Use another inventory file."],
    ["--json", "Print machine-readable output."],
    ["--dry-run", "Preview without changes or credential access."],
    ["-h, --help", "Show help for this command."],
  ],
};

export const peerHelp: Page = {
  usage: "home-ctl peer <peer-id> --target <host> -- <argv...>",
  intro:
    "Uses the peer's grants and host policy. Mutations wait for local approval on the execution peer.",
  sections: [globalOptions],
};
