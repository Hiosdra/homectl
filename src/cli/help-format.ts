// Shared shape and renderer for `home-ctl <command> --help` pages. The page
// modules (help*.ts) build Page values; help.ts selects one by topic.

export type Section = { title: string; rows: [string, string][] };
export type Page = { usage: string; intro?: string; sections: Section[] };

export const globalOptions: Section = {
  title: "Options",
  rows: [
    ["--inventory PATH", "Use another inventory file."],
    ["--json", "Print machine-readable output."],
    ["--dry-run", "Preview without changes or credential access."],
    ["-h, --help", "Show help for this command."],
  ],
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

export function formatPage(
  page: Page,
  topic: string,
  options: { width?: number; color?: boolean } = {},
): string {
  const width = Math.max(40, Math.min(options.width ?? 80, 100));
  const heading = (text: string) =>
    options.color ? `\x1b[1;36m${text}\x1b[0m` : text;
  const lines = [heading("home-ctl"), ""];
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
  lines.push("", "More help: home-ctl <command> --help");
  if (!topic)
    lines.push(
      "Exit codes: 0 success, 2 input, 3 policy, 4 confirmation,",
      "            5 transport/setup, 6 remote command failure.",
    );
  return `${lines.join("\n")}\n`;
}
