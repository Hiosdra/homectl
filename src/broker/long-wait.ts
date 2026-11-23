// Long waits for an operation, split into short requests. The broker closes an
// idle HTTP connection after 255 s (the Bun maximum), so one request that waits
// 600 s used to die and look like "the broker is not reachable". Every wait is
// now at most WAIT_CHUNK_MS per request, on the server and in the clients.
import { HomectlError } from "../types";
import { FINAL_STATES } from "./types";

// Per request. Well under the 255 s idle timeout of the broker server.
export const WAIT_CHUNK_MS = 120_000;
// The longest total wait a caller may ask for (`--wait`, `waitMs`).
export const WAIT_LIMIT_MS = 600_000;
// Consecutive dropped requests before a wait gives up.
const MAX_LOST_REQUESTS = 3;
const RETRY_DELAY_MS = 1000;

// The message callBroker uses when the request never reached the broker.
export const UNREACHABLE_MESSAGE =
  "The homectl broker is not reachable; start it with `home-ctl daemon start` or check `home-ctl doctor`";

export interface WaitView {
  id: string;
  state: string;
  [key: string]: unknown;
}

export type BrokerCall = <T>(
  path: string,
  body: Record<string, unknown>,
) => Promise<T>;

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const isFinalState = (state: string) =>
  (FINAL_STATES as readonly string[]).includes(state);

export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof HomectlError &&
    error.code === 5 &&
    error.message === UNREACHABLE_MESSAGE
  );
}

// Waits for the operation in short requests until it is final or totalMs has
// passed. A request that is dropped is retried; after MAX_LOST_REQUESTS in a row
// the caller is told the broker stopped answering while the operation waited.
// A wait that simply runs out returns the operation as it is now.
export async function waitInChunks(
  call: BrokerCall,
  id: string,
  totalMs: number,
  start?: WaitView,
  clock: WaitClock = realClock,
): Promise<WaitView> {
  const deadline = clock.now() + Math.min(Math.max(totalMs, 0), WAIT_LIMIT_MS);
  let view = start;
  let lost = 0;
  for (;;) {
    if (view && isFinalState(view.state)) return view;
    const remaining = Math.max(0, deadline - clock.now());
    if (view && remaining === 0) return view;
    try {
      view = await call<WaitView>("/v1/wait", {
        id,
        timeoutMs: Math.min(remaining, WAIT_CHUNK_MS),
      });
      lost = 0;
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      lost += 1;
      if (lost >= MAX_LOST_REQUESTS)
        throw new HomectlError(
          5,
          `Lost contact with the broker while operation ${id} was waiting. It may still be waiting for approval or running. Check it with: home-ctl wait ${id}`,
        );
      await clock.sleep(RETRY_DELAY_MS);
    }
  }
}

const LONG_WAIT_PATHS = /^\/v1\/(exec|proxmox|setup\/request\/[a-z-]+)$/;

// Starts an operation with waitMs and waits for it the long way round. A call
// that takes waitMs is sent as at most one chunk, then the rest is polled.
export async function callWithWait(
  call: BrokerCall,
  path: string,
  body: Record<string, unknown>,
  clock: WaitClock = realClock,
): Promise<WaitView> {
  const { waitMs, ...rest } = body;
  if (typeof waitMs !== "number" || !LONG_WAIT_PATHS.test(path))
    return call<WaitView>(path, body);
  const total = Math.min(Math.max(waitMs, 0), WAIT_LIMIT_MS);
  const started = clock.now();
  const first = await call<WaitView>(path, {
    ...rest,
    waitMs: Math.min(total, WAIT_CHUNK_MS),
  });
  if (first.state === "denied" || isFinalState(first.state)) return first;
  if (total <= WAIT_CHUNK_MS) return first;
  const left = total - (clock.now() - started);
  if (left <= 0) return first;
  return waitInChunks(call, first.id, left, first, clock);
}
