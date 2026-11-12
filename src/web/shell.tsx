// The workspace shell: the navigation rail (a bottom bar on phones), the top bar with
// the status pill and session state, and the screen that the current view selects.
import { BrandMark } from "./brand";
import { isReady } from "./format";
import { NAV_ICONS } from "./nav-icons";
import { Dashboard } from "./dashboard";
import { UnlockConnect } from "./unlock-connect";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import { Tag } from "./shared";
import { Approvals } from "./screens/approvals";
import { CommandPanel, PermissionPanel } from "./screens/grants";
import { Settings } from "./screens/settings";
import { SyncCompare } from "./screens/sync";
import { Devices } from "./screens/devices";
import { Vault } from "./screens/vault";
import { Welcome } from "./screens/welcome";
import { api, refresh, task, ui } from "./store";

export const NAV: [string, string][] = [
  ["dashboard", "Dashboard"],
  ["approvals", "Accept requests"],
  ["access", "Vault"],
  ["sync", "Sync"],
  ["settings", "Settings"],
];

// Shorter labels where the bottom bar is narrow.
const SHORT_LABEL: Record<string, string> = { approvals: "Requests" };

export function Screen() {
  if (ui.permissionPeer) return <PermissionPanel id={ui.permissionPeer} />;
  if (ui.commandHost) return <CommandPanel host={ui.commandHost} />;
  switch (ui.view) {
    case "approvals":
      return <Approvals />;
    case "access":
    case "machines":
      return (
        <Vault />
      );
    case "sync":
    case "peers":
      return ui.preview ? <SyncCompare p={ui.preview} /> : <Devices />;
    case "settings":
      return <Settings />;
    case "welcome":
      return <Welcome />;
    default:
      return <Dashboard state={ui.state} control={ui.control} />;
  }
}

export function Workspace() {
  const pendingCount = ui.state.pending.length;
  // Peer and machine views live under Sync and Vault now; highlight their parent.
  const current = ui.view === "peers" ? "sync" : ui.view === "machines" ? "access" : ui.view;
  const ready = (ui.control?.operations ?? []).filter((op) => isReady(op) && !op.runsOn).length;
  const needYou = pendingCount + ready;
  return (
    <div id="workspace" className="grid min-h-dvh grid-cols-[208px_minmax(0,1fr)] max-[1000px]:grid-cols-[180px_minmax(0,1fr)] max-[700px]:block">
      <aside className="relative self-stretch border-r border-border bg-rail max-[700px]:fixed max-[700px]:inset-x-0 max-[700px]:bottom-0 max-[700px]:z-20 max-[700px]:border-t max-[700px]:border-r-0">
        <div className="sticky top-0 flex h-dvh flex-col px-4 py-6 max-[700px]:static max-[700px]:h-auto max-[700px]:p-1.5 max-[700px]:pb-[calc(6px+env(safe-area-inset-bottom,0px))]">
          <a
            className="mx-2.5 mb-9 flex items-center gap-2.5 text-[22px] font-bold tracking-[-0.025em] no-underline max-[700px]:hidden"
            href="#machines"
          >
            <BrandMark />
            homectl
          </a>
          <nav aria-label="Main navigation" className="grid gap-1.5 max-[700px]:grid-cols-5 max-[700px]:gap-0.5">
            {NAV.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                data-view={id}
                aria-current={current === id ? "page" : undefined}
                className="flex items-center justify-between rounded-[7px] px-3.5 py-2.5 font-medium text-muted-foreground no-underline hover:bg-popover aria-[current=page]:bg-accent aria-[current=page]:text-foreground max-[700px]:flex-col max-[700px]:justify-center max-[700px]:gap-0.5 max-[700px]:rounded-lg max-[700px]:px-0.5 max-[700px]:py-1.5 max-[700px]:text-center max-[700px]:text-[11px] max-[700px]:leading-tight"
              >
                <span className="inline-flex items-center gap-2 max-[700px]:flex-col max-[700px]:gap-0.5 [&_svg]:size-4 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.8] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] max-[700px]:[&_svg]:size-5">
                  <span className="inline-flex" aria-hidden="true">
                    {NAV_ICONS[id]}
                  </span>
                  <span className="max-[700px]:hidden">{label}</span>
                  <span className="hidden max-[700px]:inline">{SHORT_LABEL[id] ?? label}</span>
                </span>
                {id === "sync" && pendingCount ? (
                  <span id="pending-count" className="ml-1.5 text-xs tabular-nums">
                    {pendingCount}
                  </span>
                ) : null}
                {id === "approvals" && ready ? (
                  <span id="approval-count" className="ml-1.5 text-xs tabular-nums">
                    {ready}
                  </span>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="mt-auto border-t border-border px-3 pt-5 text-xs text-muted-foreground max-[700px]:hidden">
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" aria-hidden="true" />
            Local workspace
            <p className="my-2 text-foreground">{ui.state.device.name}</p>
            <span className="text-muted-foreground">CLI + peer sync</span>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex min-h-[76px] flex-wrap items-center justify-between gap-4 border-b border-border bg-rail px-8 py-4 max-[1000px]:px-[22px] max-[700px]:gap-2 max-[700px]:px-3.5 max-[700px]:py-2.5">
          <div className="flex items-center gap-3 font-semibold">
            <span className="grid size-[34px] place-items-center rounded-lg bg-popover" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="w-[19px] fill-none stroke-muted-foreground stroke-[1.6]">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </span>
            <span id="device-name">{ui.state.device.name}</span>
            <span id="device-platform" className="text-muted-foreground max-[1000px]:hidden">
              {ui.state.device.platform}
            </span>
          </div>
          <div className="flex items-center gap-3 max-[700px]:gap-1.5">
            <a
              id="status-pill"
              href="#approvals"
              data-view="approvals"
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] whitespace-nowrap no-underline max-[700px]:px-2.5 max-[700px]:py-1 max-[700px]:text-xs",
                needYou
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-success/40 bg-success/10 text-success",
              )}
            >
              <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
              {needYou ? `${needYou} need you` : "All good"}
            </a>
            <span id="session-state">
              <Tag tone={ui.state.session.unlocked ? "success" : "neutral"}>
                {ui.state.session.unlocked ? "SSH unlocked" : "SSH locked"}
              </Tag>
            </span>
            <Button
              id="lock"
              type="button"
              variant="ghost"
              disabled={ui.busy}
              onClick={() =>
                void task(async () => {
                  await api("/api/vault/lock", {});
                  await refresh();
                })
              }
            >
              Lock
            </Button>
            <Button
              id="refresh"
              type="button"
              variant="ghost"
              disabled={ui.busy}
              className="max-[700px]:hidden"
              onClick={() => void task(refresh)}
            >
              Refresh
            </Button>
          </div>
        </header>
        <main
          id="content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1500px] px-9 py-[34px] outline-none max-[1000px]:px-6 max-[1000px]:py-7 max-[700px]:px-4 max-[700px]:py-6 max-[700px]:pb-24"
        >
          {ui.banners.error ? (
            <Alert id="error" variant="error" className="mb-5">
              <AlertDescription>{ui.banners.error}</AlertDescription>
            </Alert>
          ) : null}
          {ui.banners.notice ? (
            <Alert id="notice" variant="success" role="status" className="mb-5">
              <AlertDescription>{ui.banners.notice}</AlertDescription>
            </Alert>
          ) : null}
          <div id="screen">
            <Screen />
          </div>
        </main>
      </div>
    </div>
  );
}

export function Connection() {
  return <UnlockConnect onDone={() => void refresh()} />;
}

