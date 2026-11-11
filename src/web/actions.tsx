// The panel's actions, dispatched by data-action from the root click handler. Each case
// is one user request; the state and the server calls are the same as before the move
// to coss ui.
import { ExecutionDetails } from "./screens/execution";
import {
  announce,
  api,
  confirm,
  copyText,
  element,
  focusScreen,
  navigate,
  pairingAddress,
  refresh,
  render,
  report,
  ui,
  updateSyncPreview,
  armSyncWait,
} from "./store";
import type { ControlExecution, Preview } from "./types";
import { bucketOf, displayStateOf } from "./format";

export async function handleAction(action: string | undefined, id: string) {
  switch (action) {
    case "add":
      ui.editing = "";
      render();
      return;
    case "edit":
      ui.editing = id;
      render();
      return;
    case "machine-delete": {
      const machine = ui.state.inventory.machines[id];
      if (!machine || machine.transport !== "ssh")
        throw new Error("This machine cannot be removed here. Refresh the list.");
      if (
        !(await confirm(
          `Remove ${id}?`,
          "This removes the machine from this device's inventory and generated SSH configuration. Other devices receive the removal for review during sync. The vault credential, the remote machine, and its installed SSH keys remain.",
        ))
      )
        return;
      await api("/api/machine/delete", { name: id });
      ui.editing = undefined;
      await refresh();
      report(`Machine ${id} removed from this device.`, "notice");
      return;
    }
    case "cancel-edit":
      ui.editing = undefined;
      render();
      return;
    case "navigate-peers":
      navigate("peers");
      return;
    case "doctor":
      ui.result = await api("/api/doctor", { host: id });
      render();
      return;
    case "compare-conflict":
      ui.conflictChoice[Number(id)] = undefined;
      render();
      return;
    case "close-task":
      ui.permissionPeer = undefined;
      ui.commandHost = undefined;
      ui.commandPeer = "";
      render();
      return;
    case "command":
      ui.commandHost = id;
      ui.commandPeer = "";
      render();
      return;
    case "remote-command":
      ui.commandHost = id;
      ui.commandPeer = ui.remoteHosts?.peerId ?? "";
      render();
      return;
    case "operation-approve":
      if (
        await confirm(
          "Execute this peer operation?",
          "You are approving the exact command, target, and impact shown in the request.",
        )
      )
        ui.result = await api("/api/operation/decide", { id, approved: true });
      await refresh();
      return;
    case "control-deny": {
      if (
        !(await confirm(
          "Deny this request?",
          "It will be closed and cannot run. Another plan can be made later.",
        ))
      )
        return;
      await api("/api/control/deny", { operationId: id });
      await refresh();
      announce("Request denied.");
      return;
    }
    case "operation-reject":
      await api("/api/operation/decide", { id, approved: false });
      await refresh();
      return;
    case "operation-status":
      if (ui.operationResult) {
        ui.result = await api("/api/peer/request", {
          id: ui.operationResult.peerId,
          action: "operation-status",
          payload: { id: ui.operationResult.id },
        });
        render();
      }
      return;
    case "pair-open":
      await api("/api/pair/open", {});
      await refresh();
      return;
    case "pair-copy-command":
      await copyText(`homectl pair --address ${pairingAddress()}`);
      report(
        "Command copied. Paste it on the other computer, then enter the one-time code.",
        "notice",
      );
      return;
    case "pair-copy-code":
      if (!ui.state.pair?.code)
        throw new Error("The pairing code has expired. Start pairing again.");
      await copyText(ui.state.pair.code);
      report(
        "One-time code copied. Paste it into the private pairing prompt.",
        "notice",
      );
      return;
    case "sync-copy-unlock":
      await copyText("homectl session unlock");
      report("Unlock command copied. Run it on the device named above.", "notice");
      return;
    case "pair-confirm":
      if (
        await confirm(
          "Trust this device?",
          "Both computers must show the same phrase. This grants sync access; remote operations stay disabled.",
        )
      )
        await api("/api/pair/confirm", {
          permissions: {
            sync: true,
            diagnostics: false,
            operations: [],
            administer: false,
          },
        });
      await refresh();
      return;
    case "pair-cancel":
      await api("/api/pair/cancel", {});
      await refresh();
      return;
    case "discovered":
      element<HTMLInputElement>("peer-address").value = id;
      element<HTMLInputElement>("pair-code").focus();
      return;
    case "peer-forget":
      if (
        await confirm(
          "Remove peer trust?",
          "Future syncs will be blocked. Previously copied SSH keys need separate rotation on the hosts.",
        )
      )
        await api("/api/peer/forget", { id });
      await refresh();
      return;
    case "peer-status": {
      const status = await api<{
        hosts: { name: string; description: string; access: string }[];
      }>("/api/peer/request", { id, action: "status", payload: {} });
      ui.remoteHosts = { peerId: id, hosts: status.hosts };
      ui.result = undefined;
      render();
      return;
    }
    case "peer-permissions":
      ui.permissionPeer = id;
      render();
      return;
    case "sync-start":
      ui.syncWaiting = undefined;
      ui.syncPeerId = id;
      ui.view = "sync";
      ui.preview = await api<Preview>("/api/sync/start", { id });
      armSyncWait(ui.preview);
      render();
      return;
    case "sync-preview":
      if (ui.view !== "sync") navigate("sync");
      ui.syncWaiting = undefined;
      ui.syncPeerId = ui.state.pending.find((pending) => pending.id === id)?.peerId;
      ui.preview = await api<Preview>("/api/sync/preview", { id });
      armSyncWait(ui.preview);
      render();
      return;
    case "sync-restart":
      if (!ui.syncPeerId) throw new Error("Choose the device again to compare it.");
      if ((await updateSyncPreview(ui.syncPeerId)) && !ui.syncWaiting)
        report("Comparison updated. Review the changes before applying them.", "notice");
      return;
    case "sync-cancel":
      ui.syncWaiting = undefined;
      await api("/api/sync/cancel", { id: ui.preview?.id });
      ui.preview = undefined;
      await refresh();
      return;
    case "review-operation": {
      // Opens the request in Accept requests, with its row marked.
      const op = ui.control?.operations.find((o) => o.operationId === id);
      if (!op) return;
      navigate("approvals");
      ui.controlTab = "queue";
      ui.controlFilter = bucketOf(op);
      ui.highlightOperation = id;
      render();
      return;
    }
    case "dashboard-update": {
      if (
        !(await confirm(
          `Install homectl ${id}?`,
          "The new release is installed next to this one. Restart homectl afterwards to run it. A source checkout pulls its branch instead.",
        ))
      )
        return;
      const installed = await api<{ next: string }>("/api/update/apply", {});
      report(installed.next, "notice");
      return;
    }
    case "control-tab":
      ui.controlTab = id === "clients" ? "clients" : "queue";
      render();
      return;
    case "control-filter":
      ui.controlFilter = id === "needs" || id === "history" ? id : "ready";
      render();
      return;
    case "control-verify":
      await api("/api/control/audit/verify", {});
      await refresh();
      return;
    case "control-execute": {
      const op = ui.control?.operations.find((o) => o.operationId === id);
      if (!op) return;
      const title =
        op.classification === "destructive"
          ? "Run this destructive operation?"
          : op.classification === "inspect"
            ? "Run this inspection?"
            : "Run this change?";
      if (!(await confirm(title, "", <ExecutionDetails op={op} />))) return;
      const response = await api<ControlExecution>("/api/control/execute", {
        operationId: id,
      });
      ui.controlResult = response;
      ui.controlFilter = "history";
      await refresh();
      const label = displayStateOf(response.operation);
      const exit = response.operation.exitCode;
      announce(
        `Operation on ${response.operation.host} finished: ${label}${exit !== undefined ? `, exit ${exit}` : ""}. Result shown below.`,
      );
      focusScreen();
      return;
    }
    case "control-peer-suspend": {
      const peer = ui.control?.sync?.peers.find((p) => p.id === id);
      if (!peer) return;
      if (
        !(await confirm(
          `Suspend ${peer.name} from this device's lease?`,
          `Operations on this device may run without confirming ${peer.name} has seen the latest state. Use only if ${peer.name} is offline or will stay offline.`,
        ))
      )
        return;
      await api("/api/control/peer", { target: id, suspend: true });
      await refresh();
      announce(`${peer.name} is suspended from this device's lease.`);
      return;
    }
    case "control-peer-resume": {
      const peer = ui.control?.sync?.peers.find((p) => p.id === id);
      if (!peer) return;
      if (
        !(await confirm(
          `Resume ${peer.name} in the lease?`,
          `${peer.name} counts toward this device's lease again, so operations here wait for it to sync.`,
        ))
      )
        return;
      await api("/api/control/peer", { target: id, suspend: false });
      await refresh();
      announce(`${peer.name} counts toward the lease again.`);
      return;
    }
    case "control-result-close":
      ui.controlResult = undefined;
      render();
      return;
    case "control-revoke":
      if (
        await confirm(
          `Revoke ${id}?`,
          "Its token stops working immediately. To restore access later, create a new client from a terminal.",
        )
      )
        await api("/api/control/revoke", { id });
      await refresh();
      return;
    case "lock":
      await api("/api/vault/lock", {});
      await refresh();
      return;
  }
}
