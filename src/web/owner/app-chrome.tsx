// The frame of the owner panel: the top bar (brand and live state on phones), the
// section navigation (a bottom tab bar on phones, a sidebar on desktop) with the
// sign-out button at the foot of the sidebar, and the fallback for a request that
// is no longer waiting. Pure presentation; the app decides what each section shows.
import type { IconName } from "./icons";
import { Icon } from "./icons";
import type { Route } from "./route";
import { Notice, type Tone } from "./ui";

export interface NavItem {
  label: string;
  hash: string;
  name: Route["name"];
  icon: IconName;
}

// The owner's order: what needs them first, then the assistants, the rules they
// set, linked devices (when this broker is a workspace server) and the system.
export const NAV: NavItem[] = [
  { label: "Needs you", hash: "#/", name: "overview", icon: "inbox" },
  { label: "Assistants", hash: "#/agents", name: "agents", icon: "bot" },
  { label: "Permissions", hash: "#/policy", name: "policy", icon: "shield" },
];

// A small dot and a word: the connection state, never a pill that competes with
// the page. The colour is paired with the word, so it is never the only signal.
export function LiveStatus({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`live-status ${tone}`} role="status">
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function TopBar({
  liveTone,
  liveLabel,
  onSignOut,
}: {
  liveTone: Tone;
  liveLabel: string;
  onSignOut: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="shield" />
        </span>
        <h1>homectl owner</h1>
      </div>
      <div className="topbar-actions">
        <LiveStatus tone={liveTone} label={liveLabel} />
        <button
          type="button"
          className="sign-out sign-out-top"
          onClick={onSignOut}
        >
          <Icon name="logout" />
          <span className="btn-text">Sign out</span>
        </button>
      </div>
    </header>
  );
}

// Each item shows how many things wait behind it, if any. The count is part of
// the button's name, so a screen reader hears "Needs you 2". Only this item
// carries the count; the brand block never does.
export function MainNav({
  items,
  current,
  counts,
  onGo,
}: {
  items: NavItem[];
  current: Route["name"];
  counts: Partial<Record<Route["name"], number>>;
  onGo: (hash: string) => void;
}) {
  return (
    <nav aria-label="Owner sections">
      {items.map((item) => {
        const count = counts[item.name] ?? 0;
        return (
          <button
            key={item.hash}
            type="button"
            className={current === item.name ? "active" : ""}
            aria-current={current === item.name ? "page" : undefined}
            onClick={() => onGo(item.hash)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {count > 0 ? <span className="nav-count">{count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

// Desktop only (the phone has its sign-out in the top bar). It sits at the foot of
// the sidebar, away from the sections, as a quiet secondary action.
export function SidebarFoot({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="sidebar-foot">
      <button type="button" className="sign-out quiet" onClick={onSignOut}>
        <Icon name="logout" />
        <span className="btn-text">Sign out</span>
      </button>
    </div>
  );
}

export function Gone({ what, onBack }: { what: string; onBack: () => void }) {
  return (
    <section className="stack">
      <Notice>{what} It may have been decided, cancelled or expired.</Notice>
      <button type="button" onClick={onBack}>
        Back to what needs you
      </button>
    </section>
  );
}
