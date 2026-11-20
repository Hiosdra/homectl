// Plain words for the owner's Permissions screen. The owner is not a sysadmin, so
// the screen says "assistant" (an AI tool that asks homectl to run commands),
// "machine" (a computer homectl manages) and "AI helper" (the separate AI that
// checks requests). The technical names stay under Details, each with a short
// explanation, and the broker's routes and values are unchanged.
import type { AutoModeName, ReviewerAuthority } from "./auto-mode-api";

export type PresetId = "conservative" | "routine" | "delegated";

// The three choices the owner sees, each with its consequence in one line. The
// labels are the words on the cards; the presets are the broker's own settings.
export const PRESETS: { id: PresetId; label: string; detail: string }[] = [
  {
    id: "conservative",
    label: "Ask me first",
    detail:
      "Only your saved rules decide. Everything else waits for you. The AI helper is not used.",
  },
  {
    id: "routine",
    label: "AI helps with small fixes",
    detail:
      "The AI helper may approve small, undoable fixes. Anything bigger still waits for you.",
  },
  {
    id: "delegated",
    label: "AI decides more",
    detail:
      "The AI helper decides more requests, up to small, undoable changes. Big or risky changes still wait for you.",
  },
];

export function presetLabel(id: PresetId | undefined): string {
  return PRESETS.find((preset) => preset.id === id)?.label ?? "Custom";
}

export function modeLabel(mode: AutoModeName): string {
  switch (mode) {
    case "manual":
      return "Ask me about every request";
    case "rules":
      return "Only my saved rules decide";
    case "auto":
      return "Let the AI helper decide";
  }
}

export function modeHint(mode: AutoModeName): string {
  switch (mode) {
    case "manual":
      return "Every request waits for you. The AI helper is not called.";
    case "rules":
      return "Requests that no saved rule covers wait for you. The AI helper is not called.";
    case "auto":
      return "The AI helper decides requests it judges safe, within what you allowed. Big or risky requests still wait for you. Turning this on needs your owner password.";
  }
}

export function authorityLabel(authority: ReviewerAuthority): string {
  switch (authority) {
    case "recommend":
      return "Only give advice";
    case "routine":
      return "Decide small, undoable fixes";
    case "delegated":
      return "Decide more, up to small, undoable changes";
  }
}

export function authorityHint(authority: ReviewerAuthority): string {
  switch (authority) {
    case "recommend":
      return "The AI helper only suggests an answer. You decide each request.";
    case "routine":
      return "Only small, undoable changes. Never anything destructive, unclear or needing admin rights. Raising to this needs your owner password.";
    case "delegated":
      return "Any request it judges safe, up to small, undoable changes. Never anything destructive, unclear or needing admin rights. Raising to this needs your owner password.";
  }
}

// A rule's result, in the words the owner sees in the table.
export function effectLabel(effect: string): string {
  switch (effect) {
    case "allow":
      return "Allowed without asking";
    case "deny":
      return "Blocked";
    case "ask":
      return "Asks you first";
    default:
      return effect;
  }
}

// The risk levels, for Details. Each level is a class of command, from reading a
// few facts (R0) to destructive or trust-changing work (R4).
export const RISK_LEVELS: { level: string; meaning: string }[] = [
  {
    level: "R0",
    meaning: "Reads basic facts only. Does not count toward limits.",
  },
  {
    level: "R1",
    meaning: "Looking around: read-only checks. Does not count toward limits.",
  },
  {
    level: "R2",
    meaning: "Small, undoable change. Counts toward limits.",
  },
  {
    level: "R3",
    meaning:
      "Big or risky change, a command homectl cannot identify, or one that needs admin rights. Asks you with your owner password unless a saved rule covers it. Counts more toward limits.",
  },
  {
    level: "R4",
    meaning:
      "Destructive, changes who is trusted, or copies out passwords or keys. Always asks you with your owner password. No rule or AI helper can approve it.",
  },
];

// Words used on the screen, each with a short explanation. The raw name a
// stored value uses is given in brackets, so a technical owner can match it.
export const WORDS: { term: string; meaning: string }[] = [
  {
    term: "Assistant",
    meaning:
      "An AI tool, such as Claude or Codex, that asks homectl to run commands on your machines. Stored as a client.",
  },
  {
    term: "Machine",
    meaning: "A computer or device homectl manages. Stored as a host.",
  },
  {
    term: "Rule",
    meaning:
      "A yes or no that decides matching requests. A rule you saved from an answer you gave. Stored as a rule.",
  },
  {
    term: "AI helper",
    meaning:
      "The AI helper that checks requests when auto mode is on. It is a separate AI, and its answer is never your approval. Stored as the reviewer.",
  },
  {
    term: "Auto mode",
    meaning:
      "The setting that lets the AI helper decide requests within what you allowed. Stored as auto mode.",
  },
  {
    term: "Address (endpoint)",
    meaning:
      "The web address the AI helper answers on. Only its origin is shown, never a path.",
  },
  {
    term: "Owner password",
    meaning:
      "The password that confirms a change that matters. It is asked again for each such change.",
  },
  {
    term: "Limits (budgets)",
    meaning:
      "Caps on how many risky changes an assistant or a task may make in a time window. Going over one asks you.",
  },
  {
    term: "Task (scope)",
    meaning:
      "A group of work with its own limits, opened with home-ctl task open. A request outside a task's scope asks you.",
  },
  {
    term: "Revision",
    meaning:
      "The version number of these permissions. It goes up with each change.",
  },
  {
    term: "Which rule wins",
    meaning: "When rules disagree, a block wins, then a question, then a yes.",
  },
];

export function riskPhrase(level: string | undefined): string {
  switch (level) {
    case "R0":
      return "reading basic facts only";
    case "R1":
      return "looking around";
    case "R2":
      return "small, undoable changes";
    case "R3":
      return "big or risky changes";
    case "R4":
      return "destructive changes";
    default:
      return "any change";
  }
}
