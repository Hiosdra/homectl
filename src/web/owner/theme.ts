// Viewer theme preference for the owner panel. Stored in localStorage under
// a single allowlisted key ("system" | "light" | "dark"), never any secret.
export type ThemePreference = "system" | "light" | "dark";

const KEY = "homectl.owner.theme";
const VALID = new Set<ThemePreference>(["system", "light", "dark"]);

export function readTheme(): ThemePreference {
  try {
    const value = globalThis.localStorage?.getItem(KEY) ?? "";
    return VALID.has(value as ThemePreference)
      ? (value as ThemePreference)
      : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemePreference): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function writeTheme(theme: ThemePreference): void {
  if (!VALID.has(theme)) return;
  applyTheme(theme);
  try {
    globalThis.localStorage?.setItem(KEY, theme);
  } catch {
    /* private or blocked storage: the live theme still applies for this visit */
  }
}
