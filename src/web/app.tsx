// The panel's entry point: the root element with its delegated handlers, the connection
// gate, the workspace and the dialogs. State and server calls live in store.ts; the
// actions and form submissions live in actions.tsx and submit.ts.
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { handleAction } from "./actions";
import { ClientDialog, ConfirmDialog, UnlockDialog } from "./dialogs";
import { Connection, Workspace } from "./shell";
import { handleSubmit } from "./submit";
import {
  api,
  element,
  navigate,
  pollPairing,
  pollSyncReadiness,
  refresh,
  render,
  report,
  snapshot,
  subscribe,
  task,
  ui,
} from "./store";

function App() {
  useSyncExternalStore(subscribe, snapshot);
  // Focus the screen heading after a user action, as the imperative panel did.
  useEffect(() => {
    if (!ui.focusPending) return;
    ui.focusPending = false;
    if (ui.highlightOperation)
      document
        .querySelector(`[data-operation="${ui.highlightOperation}"]`)
        ?.scrollIntoView({ block: "center" });
    const card = document.getElementById("control-result");
    if (card) {
      card.scrollIntoView({ block: "nearest" });
      card.focus({ preventScroll: true });
      return;
    }
    const heading = document.querySelector<HTMLElement>("#screen h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  });
  return (
    <>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2.5 focus:left-2.5 focus:z-50 focus:rounded-lg focus:bg-popover focus:px-3 focus:py-2.5"
      >
        Skip to content
      </a>
      {ui.connected ? null : <Connection />}
      <div id="control-live" className="sr-only" aria-live="polite">
        {ui.announcement}
      </div>
      {ui.connected && ui.state !== undefined ? <Workspace /> : null}
      <ConfirmDialog />
      <UnlockDialog />
      <ClientDialog />
    </>
  );
}

// Delegated handlers for the whole panel. Buttons and links carry data-action,
// data-view or data-id; form fields are read by id when a form is submitted.
function onRootClick(event: ReactMouseEvent<HTMLDivElement>) {
  const target = (event.target as Element).closest<HTMLElement>("[data-action],[data-view]");
  if (!target) return;
  if (target.dataset.view) {
    event.preventDefault();
    navigate(target.dataset.view);
    return;
  }
  const action = target.dataset.action;
  const id = target.dataset.id ?? "";
  void task(() => handleAction(action, id));
}

function onRootSubmit(event: FormEvent<HTMLDivElement>) {
  const form = event.target as HTMLFormElement;
  if (form.id === "connect-form" || form.id === "sync-unlock-form" || !form.id) return;
  event.preventDefault();
  handleSubmit(form);
}

function onRootChange(event: FormEvent<HTMLDivElement>) {
  // Conflict choice: show the chosen version and hide the comparison.
  const radio = event.target as HTMLInputElement;
  if (!radio.name.startsWith("choice-")) return;
  ui.conflictChoice[Number(radio.name.slice(7))] = radio.value;
  render();
}

async function boot() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname);
    try {
      await api("/api/connect", { token });
    } catch (e) {
      report(String(e));
    }
  }
  try {
    await refresh();
  } catch {
    ui.connected = false;
    render();
  }
  const hash = location.hash.slice(1);
  // A workspace with no SSH machine and no paired device starts at Welcome.
  const fresh =
    Object.values(ui.state.inventory.machines).every((m) => m.transport === "local") &&
    ui.state.peers.length === 0;
  ui.view = [
    "dashboard",
    "approvals",
    "access",
    "machines",
    "sync",
    "peers",
    "settings",
    "welcome",
  ].includes(hash)
    ? hash
    : fresh
      ? "welcome"
      : "dashboard";
  render();
}

createRoot(element("root")).render(
  <div
    className="isolate min-h-dvh"
    onClick={onRootClick}
    onSubmit={onRootSubmit}
    onChange={onRootChange}
  >
    <App />
  </div>,
);
void boot().then(() => {
  window.setInterval(() => void pollPairing(), 2000);
  window.setInterval(() => void pollSyncReadiness(), 2000);
});
