import { helpTopics } from "./help";

export const knownCommands = new Set([
  ...helpTopics.filter(Boolean),
  "setup",
  "update",
  "hosts",
  "inspect",
  "doctor",
  "sudoers",
]);
