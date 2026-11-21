// Hash routes for the owner panel. Only section names and pending ids appear in
// the hash; never a token, password or secret value.
export type Route =
  | { name: "overview" }
  | { name: "approval"; id: string }
  | { name: "secret"; id: string }
  | { name: "agents" }
  | { name: "machines" }
  | { name: "policy" }
  | { name: "workspace" }
  | { name: "system" }
  // The guided setup. `step` is a step name ("" for the first unfinished step).
  | { name: "setup"; step: string };

export function parseRoute(hash: string): Route {
  const [section = "", id = ""] = hash.replace(/^#\/?/, "").split("/");
  if (section === "approvals") return { name: "approval", id };
  if (section === "secrets") return { name: "secret", id };
  if (section === "agents") return { name: "agents" };
  if (section === "machines") return { name: "machines" };
  if (section === "policy") return { name: "policy" };
  if (section === "workspace") return { name: "workspace" };
  if (section === "system") return { name: "system" };
  if (section === "setup") return { name: "setup", step: id };
  return { name: "overview" };
}

// The hash for a setup step (or the wizard's start). Section names only.
export function setupHash(step?: string): string {
  return step ? `#/setup/${step}` : "#/setup";
}
