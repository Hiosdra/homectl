// The frame of the owner panel: the top bar (brand, live state, sign out), the
// section navigation (a bottom tab bar on phones, a sidebar on desktop), and the
// fallback for a request that is no longer waiting. Pure presentation; the app
// decides what each section shows.
import type { IconName } from "./icons";
import { Icon } from "./icons";
import type { Route } from "./route";
import { Badge, Notice, type Tone } from "./ui";

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

export function TopBar({
  attention,
  liveTone,
  liveLabel,
  liveIcon,
  onSignOut,
}: {
  attention: number;
  liveTone: Tone;
  liveLabel: string;
  liveIcon: IconName;
  onSignOut: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="shield" />
        </span>
        <h1>homectl owner</h1>
        {attention > 0 ? <Badge tone="count">{attention} waiting</Badge> : null}
      </div>
      <div className="topbar-actions">
        <Badge tone={liveTone} icon={liveIcon}>
          {liveLabel}
        </Badge>
        <button type="button" className="sign-out" onClick={onSignOut}>
          <Icon name="logout" />
          <span className="btn-text">Sign out</span>
        </button>
      </div>
    </header>
  );
}

// Each item shows how many things wait behind it, if any. The count is part of
// the button's name, so a screen reader hears "Needs you 2".
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
