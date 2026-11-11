// Submitted forms, dispatched by form id. The connect and unlock forms have their own
// handlers; this file covers the forms that save, pair, plan or apply.
import { displayArgv } from "./format";
import {
  api,
  confirm,
  element,
  refresh,
  render,
  report,
  task,
  ui,
} from "./store";
import type { Preview } from "./types";

export function handleSubmit(form: HTMLFormElement) {
  const values = new FormData(form);
  void task(async () => {
    let successMessage = "Changes saved.";
    if (form.id === "permissions-form" && ui.permissionPeer) {
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
    if (form.id === "command-form" && ui.commandHost) {
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
      if (
        !(await confirm(
          `Run on ${host}?`,
          `${displayArgv(argv)} · ${plan.plan.classification} · ${impact}`,
        ))
      )
        return;
      const done = await api<{ pending?: boolean; id: string }>(
        id ? "/api/peer/request" : "/api/exec",
        id
          ? { id, action: "exec", payload: { ...payload, dryRun: false } }
          : { ...payload, dryRun: false, approval: plan.plan.approval },
      );
      ui.result = done;
      if (done.pending) ui.operationResult = { id: done.id, peerId: id };
      render();
      return;
    }
    if (form.id === "key-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("key-password").value = "";
      ui.result = await api("/api/key/create", {
        name: values.get("name"),
        password,
      });
    }
    if (form.id === "pair-form") {
      const code = String(values.get("code"));
      element<HTMLInputElement>("pair-code").value = "";
      await api("/api/pair/join", { address: values.get("address"), code });
      successMessage =
        "Pairing request sent. Compare the verification phrase on both devices.";
    }
    if (form.id === "unlock-form") {
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
    if (form.id === "settings-form") {
      const session = ui.state.inventory.session;
      await api("/api/settings", {
        name: values.get("name"),
        ttl: session?.ttl ?? "24h",
        idle: session?.idle ?? "2h",
      });
    }
    if (form.id === "session-form") {
      await api("/api/settings", {
        name: ui.state.device.name,
        ttl: String(values.get("ttl")),
        idle: String(values.get("idle")),
      });
    }
    if (form.id === "machine-form") {
      const name = String(values.get("name"));
      const extra = JSON.parse(String(values.get("extra")));
      await api("/api/machine/save", {
        name,
        machine: {
          ...extra,
          transport: "ssh",
          ssh_alias: name,
          address: values.get("address"),
          user: values.get("user"),
          description: values.get("description"),
          access: values.get("access"),
        },
      });
      ui.editing = undefined;
    }
    if (form.id === "sync-form" && ui.preview) {
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
