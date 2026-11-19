import type { EventEnvelope } from "../core/contracts";

const DEFAULT_WINDOW_MS = 10 * 60_000;

export interface NotificationDeduperOptions {
  // This surface's device id. Events whose origin is this device were caused
  // here, and the user already saw them, so they never notify again.
  surfaceId?: string;
  windowMs?: number;
  now?: () => number;
}

// Per-surface notification gate. A user notification fires at most once per
// (type, subject) within the window, however many surfaces or reconnects
// deliver the same event.
export class NotificationDeduper {
  private readonly surfaceId: string | undefined;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly lastNotified = new Map<string, number>();

  constructor(options: NotificationDeduperOptions = {}) {
    this.surfaceId = options.surfaceId;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  shouldNotify(
    envelope: Pick<EventEnvelope, "type" | "subject" | "origin">,
  ): boolean {
    if (this.surfaceId !== undefined && envelope.origin === this.surfaceId)
      return false;
    const now = this.now();
    for (const [key, at] of this.lastNotified)
      if (now - at >= this.windowMs) this.lastNotified.delete(key);
    const key = `${envelope.type}\n${envelope.subject}`;
    if (this.lastNotified.has(key)) return false;
    this.lastNotified.set(key, now);
    return true;
  }
}
