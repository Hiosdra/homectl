// Browser notifications for new approvals and secret requests (homelab #21 §8).
// Alerts are built only from the broker's pending lists, never from the stream
// payload. Text names the client and the host, never the command, the agent's
// narrative, the purpose of a secret or any value. The link is a section plus
// a request id, with no token. Nothing is cached by a service worker: the panel
// registers none.

import { displayName } from "./plain-words";

export type AlertPermission = "unsupported" | "default" | "granted" | "denied";

export interface Alert {
  // Canonical id: the same request always maps to the same key.
  key: string;
  title: string;
  body: string;
  // Hash route inside the panel, e.g. "#/approvals/<id>".
  link: string;
}

const MAX_REMEMBERED = 1000;

export function approvalAlert(op: {
  id: string;
  client: string;
  host: string;
}): Alert {
  return {
    key: `approval:${op.id}`,
    title: "Approval needed",
    body: `${displayName(op.client)} wants to run a command on ${op.host}. Review it in homectl.`,
    link: `#/approvals/${encodeURIComponent(op.id)}`,
  };
}

export function secretAlert(request: { id: string; client: string }): Alert {
  return {
    key: `secret:${request.id}`,
    title: "Secret requested",
    body: `${displayName(request.client)} asked for a secret. Provide it in homectl.`,
    link: `#/secrets/${encodeURIComponent(request.id)}`,
  };
}

export function workspaceApprovalAlert(op: {
  origin: string;
  id: string;
  originName: string;
}): Alert {
  return {
    key: `workspace-approval:${op.origin}:${op.id}`,
    title: "Approval needed on a linked client",
    body: `${op.originName} has a command waiting for approval.`,
    link: "#/workspace",
  };
}

// Sends each new alert once. The first observation only records what is already
// pending, so signing in does not announce old requests. A key that was shown
// is never shown again in this session, whatever the pending lists do later.
export class AlertTracker {
  private readonly seen = new Set<string>();
  private primed = false;

  constructor(
    private readonly show: (alert: Alert) => void,
    private readonly allowed: () => boolean,
  ) {}

  observe(alerts: Alert[]): void {
    const fresh = alerts.filter((alert) => !this.seen.has(alert.key));
    for (const alert of fresh) this.remember(alert.key);
    if (!this.primed) {
      this.primed = true;
      return;
    }
    if (!this.allowed()) return;
    for (const alert of fresh) this.show(alert);
  }

  // Called when the session ends, so the next sign-in starts from scratch.
  reset(): void {
    this.seen.clear();
    this.primed = false;
  }

  private remember(key: string): void {
    this.seen.add(key);
    // Oldest keys go first; a very old request cannot come back as "new".
    if (this.seen.size > MAX_REMEMBERED)
      this.seen.delete(this.seen.values().next().value as string);
  }
}

export function alertPermission(): AlertPermission {
  if (typeof Notification === "undefined") return "unsupported";
  const value = Notification.permission;
  return value === "granted" || value === "denied" ? value : "default";
}

// Must run from a user gesture (a button). Returns the browser's answer.
export async function askForAlerts(): Promise<AlertPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    const answer = await Notification.requestPermission();
    return answer === "granted" || answer === "denied" ? answer : "default";
  } catch {
    return alertPermission();
  }
}

// Shows one OS notification. The tag is the canonical key, so the OS also
// merges a repeat. Clicking focuses the panel and opens the item's section.
export function showAlert(alert: Alert): void {
  try {
    const note = new Notification(alert.title, {
      body: alert.body,
      tag: alert.key,
    });
    note.onclick = () => {
      window.focus();
      location.hash = alert.link;
      note.close();
    };
  } catch {
    // Some platforms only show notifications from a service worker. The
    // pending list in the panel still shows the item.
  }
}
