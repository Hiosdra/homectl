// Plain words for the owner's screens: how an assistant is named, and what a
// command does in one short phrase. Display only. The exact argv is always shown
// next to these words, so a phrase that falls back to "run a command" never hides
// what would run.

// The assistant's id ("codex") as a name the owner reads ("Codex"). The id is the
// broker's stable key; the owner sees the name.
export function displayName(
  id: string,
  names: Readonly<Record<string, string>> = {},
): string {
  const known = names[id];
  if (known) return known;
  const trimmed = id.trim();
  if (trimmed === "") return "An assistant";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const SERVICE_VERBS: Record<string, string> = {
  restart: "restart",
  start: "start",
  stop: "stop",
  reload: "reload",
  enable: "turn on",
  disable: "turn off",
};

// The line under a request: how big the change is, and whether the owner password
// is needed. The words follow the risk level's label.
export function riskLine(stripe: string, needsPassword: boolean): string {
  const base =
    stripe === "look"
      ? "Only looks around. Nothing changes."
      : stripe === "small"
        ? "A small change you can undo."
        : stripe === "big"
          ? "This is a big change."
          : "This can be hard to undo.";
  return needsPassword ? `${base} You'll confirm with your password.` : base;
}

// Why a request waits for the owner, in plain words. The broker's own reason text
// is kept under Details; this only says what it means for the owner.
export function whyWaits(input: {
  stripe: string;
  stepUp?: boolean;
  humanOnly?: boolean;
  underReview?: boolean;
}): string {
  if (input.underReview)
    return "The AI helper that checks requests has not decided yet.";
  if (input.humanOnly)
    return "This kind of change can only be decided by you, once.";
  if (input.stepUp) return "Changes like this always need your owner password.";
  if (input.stripe === "destructive")
    return "It could delete or change things that are hard to get back.";
  if (input.stripe === "big")
    return "It is a big change, and no saved rule covers it.";
  return "No saved rule covers it, so it waits for you.";
}

// Capitalises the first letter of a sentence fragment.
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One phrase for what a command does. Only well-known shapes get a sentence; any
// other command reads "run a command", and the exact argv sits beside it.
export function plainAction(argv: readonly string[]): string {
  const [program, ...rest] = argv;
  if (program === "systemctl") {
    const [verb, unit] = rest;
    const word = verb ? SERVICE_VERBS[verb] : undefined;
    if (word && unit) return `${word} ${unit}`;
  }
  if (program === "rm") {
    const paths = rest.filter((arg) => !arg.startsWith("-"));
    if (paths.length > 0) return `delete ${paths.join(", ")}`;
  }
  if (program === "zfs" && rest[0] === "scrub" && rest[1]) {
    return `start a scrub of ${rest[1]}`;
  }
  if (program === "reboot") return "restart the machine";
  if (program === "shutdown") return "shut the machine down";
  return "run a command";
}
