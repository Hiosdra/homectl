// Hash routes for the owner panel. Only section names and pending ids appear in
// the hash; never a token, password or secret value.
export type Route =
  | { name: "overview" }
  | { name: "approval"; id: string }
  | { name: "secret"; id: string }
  | { name: "agents" }
  | { name: "policy" }
  | { name: "workspace" }
  | { name: "system" };

export function parseRoute(hash: string): Route {
  const [section = "", id = ""] = hash.replace(/^#\/?/, "").split("/");
  if (section === "approvals") return { name: "approval", id };
  if (section === "secrets") return { name: "secret", id };
  if (section === "agents") return { name: "agents" };
  if (section === "policy") return { name: "policy" };
  if (section === "workspace") return { name: "workspace" };
  if (section === "system") return { name: "system" };
  return { name: "overview" };
}
