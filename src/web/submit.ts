// Submitted forms, dispatched by form id. The connect and unlock forms have their own
// handlers; this file covers the forms that save, pair, plan or apply.
import { displayArgv } from "./format";
import {
  api,
  confirm,
  element,
  loadAudit,
  refresh,
  render,
  report,
  task,
  ui,
} from "./store";
import type { Preview } from "./types";

// Shown when a local run is requested here: this panel only previews the plan.
export const OWNER_APPROVAL_NOTICE =
  "This panel previews local commands. Submit the command through the broker to request owner approval.";

export function parseSavedCommandArgv(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Arguments must be a valid JSON array of strings.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("Arguments must be a valid JSON array of strings.");
  return parsed;
}

export function savedCommandConfirmation(
  host: string,
  plan: {
    argv: string[];
    classification: string;
    impact: string;
    needsApproval: boolean;
  },
) {
  return {
    title: `Run saved command on ${host}?`,
    body: `Command: ${displayArgv(plan.argv)} · ${plan.classification}. Impact: ${plan.impact}${plan.needsApproval ? " · approval required" : ""}. Homectl rechecks the local policy before execution.`,
  };
}

export function handleSubmit(form: HTMLFormElement) {
  const formId = form.getAttribute("id");
  const values = new FormData(form);
  void task(async () => {
    let successMessage = "Changes saved.";
    if (formId === "permissions-form" && ui.permissionPeer) {
      const id = ui.permissionPeer;
      const permissions = {
        sync: values.has("sync"),
        diagnostics: values.has("diagnostics"),
        administer: values.has("administer"),
        operations: values.getAll("hosts"),
      };
      if (
        !(await confirm(
          "Save peer grants",
          "You are granting the selected permissions for this computer and the listed hosts.",
        ))
      )
        return;
      await api("/api/peer/permissions", {
        id,
        address: values.get("address"),
        permissions,
      });
      ui.permissionPeer = undefined;
    }
    if (formId === "command-form" && ui.commandHost) {
      const host = ui.commandHost;
      const id = String(values.get("peer"));
      const program = String(values.get("program") ?? "").trim();
      if (!program) throw new Error("Enter the program to run.");
      const args = String(values.get("arguments") ?? "")
        .split(/\r?\n/)
        .filter((arg) => arg.length > 0);
      const argv = [program, ...args];
      const impact = String(values.get("impact"));
      const payload = { host, argv, impact, dryRun: true };
      const plan = await api<{
        plan: { classification: string; approval: string };
      }>(
        id ? "/api/peer/request" : "/api/exec",
        id ? { id, action: "exec", payload } : payload,
      );
      ui.result = plan;
      render();
      // Local runs no longer use the digest approval flow: the owner approves
      // through the broker's owner panel. Peer requests keep their own path.
      if (!id) return report(OWNER_APPROVAL_NOTICE, "notice");
      if (
        !(await confirm(
          `Run on ${host}?`,
          `${displayArgv(argv)} · ${plan.plan.classification} · ${impact}`,
        ))
      )
        return;
      const done = await api<{ pending?: boolean; id: string }>(
        "/api/peer/request",
        { id, action: "exec", payload: { ...payload, dryRun: false } },
      );
      ui.result = done;
      if (done.pending) ui.operationResult = { id: done.id, peerId: id };
      render();
      return;
    }
    if (formId === "saved-command-form") {
      const hosts = String(values.get("hosts") ?? "")
        .split(/[\n,]/)
        .map((host) => host.trim())
        .filter(Boolean);
      const argv = parseSavedCommandArgv(String(values.get("argv") ?? ""));
      const parameters = String(values.get("parameters") ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, ...parts] = line.split("|");
          const secret = parts.some(
            (part) => part.trim().toLocaleLowerCase() === "secret",
          );
          const description = parts
            .filter((part) => part.trim().toLocaleLowerCase() !== "secret")
            .join("|")
            .trim();
          return {
            name: name?.trim() ?? "",
            ...(description ? { description } : {}),
            ...(secret ? { secret: true } : {}),
          };
        });
      await api("/api/commands/save", {
        id: String(values.get("id") ?? "") || undefined,
        command: {
          name: values.get("name"),
          hosts,
          argv,
          parameters,
          description: values.get("description"),
        },
      });
      ui.savedCommandDraft = undefined;
      ui.savedCommandVersion++;
      successMessage =
        "Saved command updated. Each run still uses this device's current policy.";
    }
    if (formId === "saved-command-run-form") {
      const id = String(values.get("id"));
      const host = String(values.get("host"));
      const parameters = Object.fromEntries(
        [...values.entries()]
          .filter(([name]) => name.startsWith("parameter-"))
          .map(([name, value]) => [
            name.slice("parameter-".length),
            String(value),
          ]),
      );
      const payload = { id, host, parameters };
      const preview = await api<{
        plan: {
          classification: string;
          approval: string;
          needsApproval: boolean;
          argv: string[];
          impact: string;
        };
      }>("/api/commands/run", { ...payload, dryRun: true });
      ui.result = preview;
      render();
      // Saved commands run only after an owner approval in the owner panel.
      return report(OWNER_APPROVAL_NOTICE, "notice");
    }
    if (formId === "audit-filter-form") {
      ui.auditFilters = {
        host: String(values.get("host") ?? ""),
        status: String(values.get("status") ?? ""),
        text: String(values.get("text") ?? "").trim(),
      };
      ui.auditPage = undefined;
      await loadAudit(true);
      return;
    }
    if (formId === "key-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("key-password").value = "";
      ui.result = await api("/api/key/create", {
        name: values.get("name"),
        password,
      });
    }
    if (formId === "pair-form") {
      const code = String(values.get("code"));
      element<HTMLInputElement>("pair-code").value = "";
      await api("/api/pair/join", { address: values.get("address"), code });
      successMessage =
        "Pairing request sent. Compare the verification phrase on both devices.";
    }
    if (formId === "unlock-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("password").value = "";
      const create = values.get("create") === "true";
      if (create) {
        const confirmation = String(values.get("password-confirm"));
        element<HTMLInputElement>("password-confirm").value = "";
        if (password !== confirmation)
          throw new Error("The passwords do not match. Try again.");
      }
      await api("/api/vault/unlock", { password, create });
      successMessage = create
        ? "Vault created and unlocked on this device."
        : "Vault unlocked. Credential sync is ready on this device.";
    }
    if (formId === "settings-form") {
      const session = ui.state.inventory.session;
      await api("/api/settings", {
        name: values.get("name"),
        ttl: session?.ttl ?? "24h",
        idle: session?.idle ?? "2h",
      });
    }
    if (formId === "session-form") {
      await api("/api/settings", {
        name: ui.state.device.name,
        ttl: String(values.get("ttl")),
        idle: String(values.get("idle")),
      });
    }
    if (formId === "machine-form") {
      const name = String(values.get("name"));
      // Keep what the form does not show (the key reference, sockets) from the saved machine.
      const current = ui.state.inventory.machines[name];
      const machine: Record<string, unknown> = {
        ...current,
        transport: "ssh",
        ssh_alias: name,
        address: values.get("address"),
        user: values.get("user"),
        description: values.get("description"),
        access: values.get("access"),
        enforcement: values.get("enforcement"),
      };
      const port = String(values.get("port") ?? "").trim();
      if (port === "") delete machine.port;
      else if (
        Number.isInteger(Number(port)) &&
        Number(port) >= 1 &&
        Number(port) <= 65535
      )
        machine.port = Number(port);
      else
        throw new Error(
          "The SSH port must be a number from 1 to 65535, or empty for 22.",
        );
      const lines = (field: string) =>
        String(values.get(field) ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      const cautions = lines("caution");
      if (cautions.length) machine.caution = cautions;
      else delete machine.caution;
      const adminCommands = lines("sudo_allow").map((line) =>
        line.split(/\s+/),
      );
      if (adminCommands.length) machine.sudo_allow = adminCommands;
      else delete machine.sudo_allow;
      const keyEntry = String(values.get("key_entry") ?? "").trim();
      if (current?.auth && keyEntry)
        machine.auth = { ...current.auth, entry: keyEntry };
      await api("/api/machine/save", { name, machine });
      ui.editing = undefined;
    }
    if (formId === "sync-form" && ui.preview) {
      if (!(await applySync(ui.preview, values))) return;
    }
    await refresh();
    report(successMessage, "notice");
  });
}

// Applies the selected version of each conflict, after the person confirms the sync.
// Returns false when the person cancels the confirmation, which ends the submission.
async function applySync(preview: Preview, values: FormData): Promise<boolean> {
  const choices = Object.fromEntries(
    preview.conflicts.map((c, i) => [c.id, values.get(`choice-${i}`)]),
  );
  if (
    !(await confirm(
      "Apply this sync?",
      "Selected versions will be saved locally. The other peer receives the changes for its own review. Your SSH session will be locked.",
    ))
  )
    return false;
  ui.result = await api("/api/sync/apply", { id: preview.id, choices });
  ui.preview = undefined;
  return true;
}
