// Wires the panel gate to the vault session. Kept apart from the gate so the gate
// stays pure and testable without KeePassXC.
import { dirname, join } from "node:path";
import { loadInventory } from "../inventory";
import { lockSession, unlockSession } from "../session";
import { idleSeconds } from "../session/config";
import { loadOrCreateServerKeys, PanelGate } from "./unlock-gate";

export async function openPanelGate(
  inventoryPath: string,
  cookie: string,
): Promise<PanelGate> {
  const inventory = await loadInventory(inventoryPath);
  const idle = inventory.session?.idle ?? "2h";
  const keys = await loadOrCreateServerKeys(
    join(dirname(inventoryPath), "serve"),
  );
  return new PanelGate({
    keys,
    cookie,
    idleMs: idleSeconds(idle) * 1000,
    onLock: () => {
      lockSession(inventoryPath).catch(() => undefined);
    },
  });
}

// Checks the vault password against the database. A wrong password throws.
export async function unlockVault(
  inventoryPath: string,
  password: string,
): Promise<void> {
  await unlockSession(
    await loadInventory(inventoryPath),
    inventoryPath,
    async () => password,
  );
}
