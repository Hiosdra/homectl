// Desktop notifications for requests that need the person. A request that starts waiting
// for approval is announced once. A ready request is announced once, two minutes before it
// expires. The first check only records what is already there, so starting the panel does
// not announce old requests.
import { type Notice, notify } from "../notify";

export const WARN_BEFORE_MS = 2 * 60 * 1000;

export type WatchedOperation = {
  operationId: string;
  host: string;
  state: string;
  needsApproval: boolean;
  expiresAt: string;
  argv: string[];
};

export class AttentionWatch {
  readonly #send: (notice: Notice) => void;
  readonly #now: () => number;
  readonly #waiting = new Set<string>();
  readonly #expiring = new Set<string>();
  #primed = false;

  constructor(options: { send: (notice: Notice) => void; now?: () => number }) {
    this.#send = options.send;
    this.#now = options.now ?? Date.now;
  }

  // Returns the notices it sent. Each operation is announced at most once per kind.
  check(operations: WatchedOperation[]): Notice[] {
    const now = this.#now();
    const notices: Notice[] = [];
    const live = new Set(operations.map((op) => op.operationId));
    for (const op of operations) {
      const label = `${op.host}: ${op.argv.join(" ")}`;
      if (op.state === "pending" && op.needsApproval) {
        if (!this.#waiting.has(op.operationId)) {
          this.#waiting.add(op.operationId);
          if (this.#primed)
            notices.push({
              title: "Request waiting for approval",
              body: label,
            });
        }
        continue;
      }
      const ready =
        op.state === "approved" ||
        (op.state === "pending" && !op.needsApproval);
      if (!ready) continue;
      const remaining = Date.parse(op.expiresAt) - now;
      if (
        remaining > 0 &&
        remaining <= WARN_BEFORE_MS &&
        !this.#expiring.has(op.operationId)
      ) {
        this.#expiring.add(op.operationId);
        if (this.#primed)
          notices.push({
            title: "Request expires soon",
            body: `${label} (${Math.ceil(remaining / 60_000)} min left)`,
          });
      }
    }
    // Forget operations that are gone, so the sets do not grow without bound.
    for (const id of [...this.#waiting])
      if (!live.has(id)) this.#waiting.delete(id);
    for (const id of [...this.#expiring])
      if (!live.has(id)) this.#expiring.delete(id);
    this.#primed = true;
    for (const notice of notices) this.#send(notice);
    return notices;
  }
}

// Checks on an interval and returns a function that stops the timer.
export function startAttentionWatch(
  read: () => Promise<WatchedOperation[]>,
  intervalMs = 30_000,
): () => void {
  const watch = new AttentionWatch({
    send: (notice) => {
      void notify(notice);
    },
  });
  const timer = setInterval(() => {
    void read()
      .then((operations) => watch.check(operations))
      .catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
