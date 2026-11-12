// The panel's state and the requests it makes. Screens read `ui` and call `render()`
// after a change; nothing here renders JSX.
import type { ReactNode } from "react";
import type { ControlBucket } from "./format";
import { type AppliedChange, appliedChanges, autoApplies } from "./format";
import type {
  ControlExecution,
  ControlOverview,
  Preview,
  State,
} from "./types";

export type Banners = { error?: string; notice?: string; connection?: string };

export type ConfirmRequest = {
  title: string;
  body: ReactNode;
  resolve: (ok: boolean) => void;
  returnTo?: HTMLElement;
};

export type UnlockRequest = {
  resolve: (ok: boolean) => void;
  error?: string;
  submitting: boolean;
};

export const ui = {
  // Set after the first successful connection to the workspace.
  state: undefined as unknown as State,
  connected: false,
  view: "dashboard",
  banners: {} as Banners,
  announcement: "",
  focusPending: false,
  busy: false,
  // Sync comparison, from the device list or the pending list.
  preview: undefined as Preview | undefined,
  syncPeerId: undefined as string | undefined,
  syncWaiting: undefined as { peerId: string; previewId: string } | undefined,
  syncPoll: false,
  syncPollAfter: 0,
  syncWaitStatus:
    "Waiting for the vault. This comparison updates automatically when it is unlocked.",
  conflictChoice: {} as Record<number, string | undefined>,
  pairingPoll: false,
  editing: undefined as string | undefined,
  result: undefined as unknown,
  permissionPeer: undefined as string | undefined,
  commandHost: undefined as string | undefined,
  commandPeer: "",
  operationResult: undefined as { id: string; peerId: string } | undefined,
  remoteHosts: undefined as
    | {
        peerId: string;
        hosts: { name: string; description: string; access: string }[];
      }
    | undefined,
  filterText: "",
  control: undefined as ControlOverview | undefined,
  controlTab: "queue" as "queue" | "clients",
  controlFilter: "ready" as ControlBucket,
  controlResult: undefined as ControlExecution | undefined,
  // The request a dashboard Review opened; its row is marked and scrolled to.
  highlightOperation: undefined as string | undefined,
  // The request open in the side panel of Accept requests.
  selectedOperation: undefined as string | undefined,
  // Pairing as a three-step dialog, opened from Sync.
  pairWizard: false,
  pairStep: 1 as 1 | 2 | 3,
  // Changes the last sync applied on their own, shown until dismissed.
  applied: undefined as { items: AppliedChange[]; at: number } | undefined,
  // Result of the last "Check" per machine: reachable or not, with a short note.
  machineStatus: {} as Record<string, { ok: boolean; text: string }>,
  // Dialogs opened from Settings and Welcome.
  clientDialog: false,
  lengthOpen: false,
  confirmRequest: undefined as ConfirmRequest | undefined,
  unlockRequest: undefined as UnlockRequest | undefined,
};

const listeners = new Set<() => void>();
let version = 0;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function snapshot() {
  return version;
}

export function render() {
  version += 1;
  for (const listener of listeners) listener();
}

// Moves focus to the screen heading (or the result card) after a user action.
export function focusScreen() {
  ui.focusPending = true;
  render();
}

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing ${id}`);
  return e as T;
}

export function pairingAddress() {
  try {
    const peer = new URL(ui.state.address);
    const panel = new URL(location.origin);
    if (
      panel.hostname !== "127.0.0.1" &&
      panel.hostname !== "localhost" &&
      panel.hostname !== "[::1]"
    ) {
      panel.protocol = "http:";
      panel.port = peer.port || "7448";
      panel.pathname = "/";
      panel.search = "";
      panel.hash = "";
      return panel.origin;
    }
    return peer.origin;
  } catch {
    return ui.state.address;
  }
}

export async function api<T = unknown>(
  path: string,
  value?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method: value === undefined ? "GET" : "POST",
    headers: value === undefined ? {} : { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  let v: Record<string, unknown>;
  try {
    v = (await r.json()) as Record<string, unknown>;
  } catch {
    throw new Error(
      r.ok
        ? "The workspace returned an unreadable response. Refresh and try again."
        : `The workspace could not complete this request (${r.status}). Refresh and try again.`,
    );
  }
  if (!r.ok)
    throw new Error(
      typeof v.error === "string" ? v.error : "The operation failed.",
    );
  return v as T;
}

export async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied)
    throw new Error("Copy failed. Select the text and copy it manually.");
}

export function report(message: string, kind = "error") {
  if (kind === "notice") ui.banners = { ...ui.banners, notice: message };
  else if (!ui.connected) ui.banners = { ...ui.banners, connection: message };
  else ui.banners = { ...ui.banners, error: message };
  render();
}

export function announce(message: string) {
  ui.announcement = message;
  render();
}

// Opens the vault-unlock dialog for the sync flow; resolves when it closes.
export function unlockForSync(): Promise<boolean> {
  return new Promise((resolve) => {
    ui.unlockRequest = { resolve, submitting: false };
    render();
  });
}

export function closeUnlock(ok: boolean) {
  const request = ui.unlockRequest;
  ui.unlockRequest = undefined;
  render();
  request?.resolve(ok);
}

// The confirmation dialog. Plain text, or JSX details built by the caller.
export function confirm(title: string, description: string, body?: ReactNode) {
  const returnTo =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  return new Promise<boolean>((resolve) => {
    ui.confirmRequest = {
      title,
      body: body ?? description,
      returnTo,
      resolve: (ok) => {
        ui.confirmRequest = undefined;
        render();
        resolve(ok);
        // The opener is re-enabled when its task finishes; restore focus after that.
        setTimeout(() => {
          if (
            returnTo?.isConnected &&
            !(returnTo as HTMLButtonElement).disabled
          )
            returnTo.focus();
        }, 0);
      },
    };
    render();
  });
}

export function syncWaitVisible() {
  return (
    ui.syncWaiting !== undefined && ui.syncWaiting.previewId === ui.preview?.id
  );
}

export function armSyncWait(next: Preview) {
  ui.syncWaiting =
    next.blocker?.type === "remote_vault_locked" && ui.syncPeerId
      ? { peerId: ui.syncPeerId, previewId: next.id }
      : undefined;
  ui.syncPollAfter = 0;
  ui.conflictChoice = {};
}

// The changes that do not conflict: they apply without a choice.
export function cleanChanges(p: Preview): string[] {
  const conflicting = new Set(p.conflicts.map((c) => c.id));
  return p.changes.filter((id) => !conflicting.has(id));
}

export async function updateSyncPreview(peerId: string) {
  const old = ui.preview;
  const next = await api<Preview>("/api/sync/start", { id: peerId });
  // Navigation or another action can change the selected device while the
  // network request is in flight. Never replace that newer view.
  if (ui.syncPeerId !== peerId || ui.view !== "sync") {
    await api("/api/sync/cancel", { id: next.id }).catch(() => {});
    return false;
  }
  ui.preview = next;
  if (autoApplies(next)) {
    ui.result = await api("/api/sync/apply", { id: next.id, choices: {} });
    ui.applied = { items: appliedChanges(next, next.changes), at: Date.now() };
    ui.preview = undefined;
    announce(
      `Synced ${next.changes.length} change${next.changes.length === 1 ? "" : "s"}.`,
    );
  } else if (cleanChanges(next).length > 0 && !next.blocker) {
    // Clean changes apply on their own; the conflicts stay for a choice.
    const items = cleanChanges(next);
    await api("/api/sync/apply", { id: next.id, choices: {}, partial: true });
    const remaining = await api<Preview>("/api/sync/start", { id: peerId });
    // Report only what is no longer different. The merge can keep the local version of a
    // clean change; that change is still listed here, so it was not applied.
    const done = items.filter((id) => !remaining.changes.includes(id));
    ui.applied = done.length
      ? { items: appliedChanges(next, done), at: Date.now() }
      : undefined;
    ui.preview = remaining.changes.length ? remaining : undefined;
    if (ui.preview) armSyncWait(remaining);
    else await api("/api/sync/cancel", { id: remaining.id }).catch(() => {});
  } else {
    armSyncWait(next);
  }
  if (old && old.id !== next.id)
    await api("/api/sync/cancel", { id: old.id }).catch(() => {});
  render();
  return true;
}

export async function task(fn: () => Promise<void>) {
  if (ui.busy) return;
  ui.busy = true;
  ui.banners = {};
  render();
  try {
    await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "Unlock the local vault before accepting credential changes"
    ) {
      if (await unlockForSync()) {
        await refresh();
        if (ui.syncPeerId && ui.view === "sync") {
          try {
            if ((await updateSyncPreview(ui.syncPeerId)) && !ui.syncWaiting)
              report(
                "Vault unlocked. Review the updated changes before applying them.",
                "notice",
              );
          } catch (error) {
            report(
              error instanceof Error
                ? error.message
                : "Could not update the comparison. Try again.",
            );
          }
        } else report("Vault unlocked. Choose a device to compare.", "notice");
      }
      return;
    }
    if (
      e instanceof Error &&
      e.message ===
        "The other device's vault was locked when the devices were compared. Unlock it there and compare again." &&
      ui.preview &&
      ui.syncPeerId
    ) {
      ui.syncWaiting = { peerId: ui.syncPeerId, previewId: ui.preview.id };
      ui.syncPollAfter = 0;
      render();
      return;
    }
    report(
      e instanceof Error
        ? e.message
        : "The operation failed. Refresh the workspace and try again.",
    );
  } finally {
    ui.busy = false;
    focusScreen();
  }
}

export async function pollSyncReadiness() {
  const waiting = ui.syncWaiting;
  if (
    !waiting ||
    ui.syncPoll ||
    ui.busy ||
    ui.view !== "sync" ||
    document.visibilityState !== "visible" ||
    Date.now() < ui.syncPollAfter
  )
    return;
  ui.syncPoll = true;
  try {
    const readiness = await api<{ vaultUnlocked: boolean }>(
      "/api/sync/readiness",
      { id: waiting.peerId },
    );
    if (
      ui.syncWaiting !== waiting ||
      ui.preview?.id !== waiting.previewId ||
      ui.view !== "sync" ||
      ui.busy
    )
      return;
    if (!readiness.vaultUnlocked) {
      ui.syncPollAfter = Date.now() + 5000;
      return;
    }
    await task(async () => {
      if (ui.syncWaiting !== waiting || ui.preview?.id !== waiting.previewId)
        return;
      if ((await updateSyncPreview(waiting.peerId)) && !ui.syncWaiting)
        report(
          "The other vault is unlocked. Review the updated changes before applying them.",
          "notice",
        );
    });
  } catch {
    if (ui.syncWaiting === waiting && ui.view === "sync") {
      ui.syncPollAfter = Date.now() + 10_000;
      ui.syncWaitStatus =
        "Can't reach the other device yet. Retrying automatically; you can also compare again.";
      render();
    }
  } finally {
    ui.syncPoll = false;
  }
}

export async function refresh() {
  ui.state = await api<State>("/api/state");
  ui.connected = true;
  ui.control = await api<ControlOverview>("/api/control").catch(
    () => undefined,
  );
  render();
}

export async function pollPairing() {
  if (
    ui.busy ||
    ui.pairingPoll ||
    ui.view !== "peers" ||
    !ui.state?.pair ||
    document.visibilityState !== "visible"
  )
    return;
  ui.pairingPoll = true;
  try {
    const current = ui.state.pair;
    if (current.sas && current.localConfirmed && !current.remoteConfirmed)
      await api("/api/pair/poll", {});
    const next = await api<State>("/api/state");
    const before = JSON.stringify({
      pair: ui.state.pair,
      peers: ui.state.peers,
      discovery: ui.state.discovery,
    });
    const after = JSON.stringify({
      pair: next.pair,
      peers: next.peers,
      discovery: next.discovery,
    });
    ui.state = {
      ...ui.state,
      pair: next.pair,
      peers: next.peers,
      discovery: next.discovery,
    };
    if (before !== after) render();
  } catch {
    // Pairing is time-limited; a later poll or the visible error from a user action is clearer.
  } finally {
    ui.pairingPoll = false;
  }
}

export function navigate(next: string) {
  ui.view = next;
  ui.highlightOperation = undefined;
  // Banners describe the view that produced them; they do not follow the user.
  ui.banners = { connection: ui.banners.connection };
  ui.editing = undefined;
  ui.permissionPeer = undefined;
  ui.commandHost = undefined;
  ui.commandPeer = "";
  ui.remoteHosts = undefined;
  ui.result = undefined;
  ui.filterText = "";
  location.hash = next;
  focusScreen();
}
