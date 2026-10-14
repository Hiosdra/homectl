import { localApi } from "../peer/local-api";
import { HomectlError, type Inventory } from "../types";
import { lockSession, readPassword, unlockSession } from ".";

type WorkspaceState = {
  vaultUnlocked: boolean;
  session: { unlocked: boolean; expiresAt?: number | null };
};
export async function sessionWorkspace(
  action: "unlock" | "lock",
  inventory: Inventory,
  path: string,
  passwordPrompt = readPassword,
  api = localApi,
) {
  let state: WorkspaceState | undefined;
  try {
    state = await api<WorkspaceState>(path, "/api/state");
  } catch (error) {
    const cause = error as { cause?: { code?: string } };
    if (
      !(
        error instanceof HomectlError &&
        error.message === "Start homectl serve or its service first"
      ) &&
      cause.cause?.code !== "ECONNREFUSED"
    )
      throw error;
  }
  if (state) {
    if (action === "lock") {
      await api(path, "/api/vault/lock", {});
      return {
        unlocked: false,
        syncUnlocked: false,
        note: "SSH session and synchronization vault locked",
      };
    }
    if (!state.vaultUnlocked) {
      const password = await passwordPrompt(
        "Local KeePassXC password (SSH and sync): ",
      );
      await api(path, "/api/vault/unlock", { password, create: false });
    } else if (
      !state.session.unlocked &&
      Object.values(inventory.machines).some((machine) => machine.auth)
    ) {
      const password = await passwordPrompt(
        "Local KeePassXC password (SSH and sync): ",
      );
      await api(path, "/api/vault/unlock", { password, create: false });
    }
    const refreshed = await api<WorkspaceState>(path, "/api/state");
    return {
      ...refreshed.session,
      syncUnlocked: refreshed.vaultUnlocked,
      note: "Local synchronization vault unlocked; credentials are transferred only after reviewing sync",
    };
  }
  if (action === "lock")
    return { ...(await lockSession(path)), syncUnlocked: false };
  return {
    ...(await unlockSession(inventory, path, passwordPrompt)),
    syncUnlocked: false,
    note: "SSH unlocked. Start homectl serve and run session unlock again to unlock synchronization. No database password is retained by the SSH session.",
  };
}
