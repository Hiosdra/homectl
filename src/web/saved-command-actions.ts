import { savedCommandDraftFromAuditRow } from "./screens/audit";
import { api, confirm, loadAudit, navigate, render, report, ui } from "./store";

export async function handleSavedCommandAction(
  action: string | undefined,
  id: string,
): Promise<boolean> {
  switch (action) {
    case "saved-command-new":
      ui.savedCommandRun = undefined;
      ui.savedCommandDraft = { name: "", hosts: [], argv: [], parameters: [] };
      navigate("commands");
      return true;
    case "saved-command-run":
      ui.savedCommandDraft = undefined;
      ui.savedCommandRun = id;
      navigate("commands");
      return true;
    case "saved-command-edit": {
      const { commands } = await api<{
        commands: import("./types").SavedCommandListItem[];
      }>("/api/commands");
      const command = commands.find((item) => item.id === id);
      if (!command || "status" in command)
        throw new Error("Saved command is invalid or no longer exists. Review the list.");
      ui.savedCommandDraft = command;
      ui.savedCommandRun = undefined;
      navigate("commands");
      return true;
    }
    case "saved-command-cancel-edit":
      ui.savedCommandDraft = undefined;
      render();
      return true;
    case "saved-command-cancel-run":
      ui.savedCommandRun = undefined;
      ui.result = undefined;
      render();
      return true;
    case "saved-command-remove": {
      if (!(await confirm(
        "Remove saved command?",
        "This deletion will be included in the next reviewed sync with paired peers.",
      ))) return true;
      const command = await api<{ removed: string }>("/api/commands/remove", { id });
      ui.savedCommandVersion++;
      if (ui.savedCommandRun === id) ui.savedCommandRun = undefined;
      report("Saved command " + command.removed + " removed.", "notice");
      return true;
    }
    case "audit-clear": {
      if (!(await confirm(
        "Clear local command history?",
        "This permanently removes ordinary command-history rows from this device. The control-plane journal is not changed.",
      ))) return true;
      const result = await api<{ cleared: boolean }>("/api/audit/clear", {});
      ui.auditPage = undefined;
      await loadAudit(true);
      report(
        result.cleared
          ? "Local command history cleared."
          : "Local command history was not cleared; check the warning in the server log.",
        result.cleared ? "notice" : "error",
      );
      return true;
    }
    case "audit-save-command": {
      const row = ui.auditPage?.entries.find((entry) => entry.id === id);
      ui.savedCommandDraft = savedCommandDraftFromAuditRow(row);
      ui.savedCommandRun = undefined;
      navigate("commands");
      return true;
    }
    default:
      return false;
  }
}
