import type { Hub } from "./hub";
import type { Choice } from "./sync";

// The local sync apply request. `partial` writes the clean changes now and leaves the
// conflicts for a later choice.
export function syncApply(hub: Hub, v: Record<string, unknown>) {
  return hub.syncCommit(
    String(v.id),
    (v.choices ?? {}) as Record<string, Choice>,
    v.partial === true,
  );
}
