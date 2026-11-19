// Consolidated review list for migrating many hosts to homectl drop-ins.
// Nothing is written here; foreign, drifted or unsupported hosts are isolated
// as "skip" exceptions for individual review.
import { parseManaged } from "./dropin";
import type { Platform } from "./types";
import { sha256Hex } from "./util";

export type BatchAction = "create" | "update" | "none" | "skip";

export interface BatchHost {
  name: string;
  platform: Platform;
  // Live drop-in content read earlier; undefined when the file is absent.
  current?: string;
  desired: string;
}

export interface BatchReviewItem {
  host: string;
  action: BatchAction;
  reason: string;
}

export function planBatch(hosts: BatchHost[]): BatchReviewItem[] {
  const seen = new Set<string>();
  return hosts.map((host): BatchReviewItem => {
    const item = (action: BatchAction, reason: string): BatchReviewItem => ({
      host: host.name,
      action,
      reason,
    });
    if (seen.has(host.name))
      return item("skip", "duplicate host name in batch");
    seen.add(host.name);

    if (!host.platform.supports.dropIns)
      return item(
        "skip",
        `drop-ins unsupported: ${host.platform.reasons.join("; ") || "no reason recorded"}`,
      );

    const desired = parseManaged(host.desired);
    if (!desired || desired.sha256 !== sha256Hex(desired.body))
      return item(
        "skip",
        "desired content is not a valid homectl-managed drop-in",
      );

    if (host.current === undefined) return item("create", "no drop-in present");

    const live = parseManaged(host.current);
    if (!live)
      return item(
        "skip",
        "foreign file present; not overwritten, review manually",
      );
    if (live.sha256 !== sha256Hex(live.body))
      return item(
        "skip",
        "drift: managed file was modified outside homectl; review before update",
      );
    if (host.current === host.desired)
      return item("none", "already matches the desired drop-in");
    return item(
      "update",
      "managed drop-in differs; preview the diff before applying",
    );
  });
}
