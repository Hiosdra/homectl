import { dirname, join, resolve } from "node:path";
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
  const directory = `${resolve(inventoryPath)}.session`;
  const socket = join(directory, "agent.sock");
  if (Buffer.byteLength(socket) >= 100)
    throw new HomectlError(
      2,
      "Inventory path is too long for an SSH agent socket",
    );
  return {
    directory,
    socket,
    control: join(directory, "control.sock"),
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
