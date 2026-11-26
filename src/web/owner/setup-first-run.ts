// When the panel opens the guided setup on its own (audit B-first-run). Pure, so the
// rule can be tested without a browser: a broker that has never shown Welcome opens
// there on the owner's first sign-in, and only when no other section was asked for
// (an approval link is never replaced). Once Welcome is seen, it is never forced again.
import type { SetupStatus } from "./setup-api";
import { setupHash } from "./route";

export function autoOpenTarget(
  status: SetupStatus | undefined,
  hash: string,
): string | undefined {
  if (!status) return undefined;
  const bare = hash === "" || hash === "#" || hash === "#/";
  if (!bare) return undefined;
  if (status.welcomed || status.completed) return undefined;
  return setupHash("welcome");
}
