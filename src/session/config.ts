import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { windows } from "../platform";
import { HomectlError, type Inventory } from "../types";

export function ttlSeconds(ttl: string): number | null {
  if (ttl === "until-reboot") return null;
  const match = /^([1-9][0-9]{0,6})([smhd])$/.exec(ttl);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match?.[2] ?? ""];
  const seconds = Number(match?.[1]) * (unit ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 365 * 86400)
    throw new HomectlError(2, "TTL must be 1s through 365d, or until-reboot");
  return seconds;
}

export function sessionPaths(inventoryPath: string) {
  const hash = createHash("sha256")
    .update(resolve(inventoryPath))
    .digest("hex")
    .slice(0, 32);
  const fullDirectory = `${resolve(inventoryPath)}.session`;
  const directory =
    !windows && Buffer.byteLength(join(fullDirectory, "agent.sock")) >= 100
      ? join(
          tmpdir(),
          `homectl-${process.getuid?.() ?? "user"}-${hash}.session`,
        )
      : fullDirectory;
  const pipe = String.raw`\\.\pipe\homectl-${hash}`;
  const socket = windows ? `${pipe}-agent` : join(directory, "agent.sock");
  return {
    directory,
    socket,
    control: windows ? `${pipe}-control` : join(directory, "control.sock"),
    keys: join(dirname(inventoryPath), "public-keys"),
  };
}

export function sessionConfig(inv: Inventory, inventoryPath: string) {
  return (
    inv.session ?? {
      ttl: "24h",
      database: join(dirname(resolve(inventoryPath)), "homelab.kdbx"),
    }
  );
}
