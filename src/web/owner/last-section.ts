// The section a viewer used last, so the panel can open there again. Only the
// section name is stored: never a token, a password, a secret or an approval id.
// Storage can be blocked or full (private windows, cleared site data), so every
// access is wrapped and the panel works without it.
const KEY = "homectl.owner.lastSection";

const HASH_OF: Record<string, string> = {
  overview: "#/",
  agents: "#/agents",
  policy: "#/policy",
  workspace: "#/workspace",
  system: "#/system",
};

export function writeLastSection(name: string): void {
  if (!Object.hasOwn(HASH_OF, name)) return;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Remembering is a convenience; a blocked store changes nothing else.
  }
}

// The hash to reopen, or undefined when nothing valid was remembered.
export function readLastSection(): string | undefined {
  try {
    const name = localStorage.getItem(KEY);
    return name !== null && Object.hasOwn(HASH_OF, name)
      ? HASH_OF[name]
      : undefined;
  } catch {
    return undefined;
  }
}
