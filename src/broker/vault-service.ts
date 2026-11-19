// The broker's vault (homelab #21 B7/B8, A3). The embedded KDBX replaces the
// external keepassxc-cli unlock: the owner's vault master password is the
// owner credential, a successful sign-in or step-up unlocks the vault, and the
// broker loads host keys into its own session agent (the one the 0.2 SSH
// worker already uses). Admin-tagged keys load only after an explicit
// elevation, with an ssh-agent lifetime equal to the privileged window.
// Locking clears the agent, drops in-memory secrets, ends owner sessions,
// cancels queued approvals and stops new dispatch.
import { loadInventory } from "../inventory";
import { apiTokenSecretName } from "../session";
import { HomectlError, type Inventory } from "../types";
import {
  type CredentialSource,
  openDatabase,
  passwordSource,
  type VaultSession,
} from "../vault";
import type { OwnerVerifier } from "./owner";
import type { RouteExtension } from "./server";

// How keys reach SSH. The default uses the 0.2 session agent; tests inject.
export interface KeyAgentPort {
  start(inventory: Inventory): Promise<void>;
  add(key: Uint8Array, lifetimeSeconds: number | undefined): Promise<void>;
  putSecret(name: string, value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface VaultServiceOptions {
  vaultPath: string;
  inventoryPath: string;
  session: VaultSession;
  agent: KeyAgentPort;
  now: () => number;
  // Called after every lock, whatever its cause (manual, idle, absolute).
  onLocked: (reason: string) => Promise<void>;
}

const LOCKED = "vault-locked";

export class VaultService implements OwnerVerifier, RouteExtension {
  private unlocking: Promise<unknown> | undefined;
  // Expiry is evaluated lazily by the session; this sweep makes an idle or
  // absolute timeout take effect (and clear the agent) without any request.
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly options: VaultServiceOptions) {
    options.session.onLock((reason) => {
      void options.agent
        .clear()
        .catch(() => undefined)
        .then(() => options.onLocked(`${LOCKED}:${reason}`))
        .catch(() => undefined);
    });
    this.sweep = setInterval(() => options.session.check(), 15_000);
    this.sweep.unref?.();
  }

  // Daemon shutdown: keys must not outlive the broker in its agent.
  async shutdown(clearAgent: boolean) {
    clearInterval(this.sweep);
    if (!clearAgent) return;
    this.options.session.lock("manual");
    await this.options.agent.clear().catch(() => undefined);
  }

  async exists(): Promise<boolean> {
    return Bun.file(this.options.vaultPath).exists();
  }

  // Dispatch gate: a reason while locked, undefined when work may start.
  // Checking never extends the idle timer; starting work does.
  gate = (): string | undefined => {
    if (!this.options.session.check()) return LOCKED;
    this.options.session.touch();
    return undefined;
  };

  // Owner verification doubles as unlock: the same secret opens the vault.
  async verify(secret: string): Promise<boolean> {
    const source = passwordSource(secret);
    if (!this.options.session.check()) {
      try {
        await this.unlock(source);
        return true;
      } catch {
        return false;
      }
    }
    try {
      await openDatabase(this.options.vaultPath, source);
      this.options.session.touch();
      return true;
    } catch {
      return false;
    }
  }

  private async unlock(source: CredentialSource): Promise<void> {
    if (this.unlocking) await this.unlocking.catch(() => undefined);
    if (this.options.session.check()) return;
    const work = (async () => {
      await this.options.session.unlock(this.options.vaultPath, source);
      try {
        await this.loadKeys(false);
      } catch (error) {
        this.options.session.lock("emergency");
        throw error;
      }
    })();
    this.unlocking = work;
    try {
      await work;
    } finally {
      this.unlocking = undefined;
    }
  }

  // Loads host keys into the session agent. Without elevation admin keys are
  // skipped (they stay locked even after a restart; B8).
  private async loadKeys(admin: boolean): Promise<number> {
    const inventory = await loadInventory(this.options.inventoryPath);
    const { session, agent } = this.options;
    const metas = new Map(session.listEntries().map((m) => [m.name, m]));
    const state = session.state();
    const privilegedUntil = state.privilegedUntil;
    if (!admin) await agent.start(inventory);
    let loaded = 0;
    for (const machine of Object.values(inventory.machines)) {
      const entry =
        machine.auth?.type === "keepassxc" ? machine.auth.entry : undefined;
      if (!entry) continue;
      const meta = metas.get(entry);
      if (!meta || meta.admin !== admin) continue;
      const until = admin ? privilegedUntil : (state.expiresAt ?? undefined);
      const lifetime =
        until === undefined
          ? undefined
          : Math.max(1, Math.floor((until - this.options.now()) / 1000));
      const key = session.getSshKey(entry);
      try {
        await agent.add(key.privateKey, lifetime);
        loaded += 1;
      } finally {
        key.privateKey.fill(0);
      }
    }
    if (!admin)
      for (const [name, provider] of Object.entries(
        inventory.providers ?? {},
      )) {
        const meta = provider.api
          ? metas.get(provider.api.token_entry)
          : undefined;
        if (!meta || meta.admin) continue;
        const fields = session.getSecret(meta.id);
        const tokenId = fields.UserName ?? "";
        const secret = fields.Password ?? "";
        if (
          !/^[^\s=!]+@[^\s=!]+![^\s=!]+$/.test(tokenId) ||
          !secret ||
          /\s/.test(secret)
        )
          throw new HomectlError(5, "Proxmox API token entry is malformed");
        await agent.putSecret(
          apiTokenSecretName(name),
          `PVEAPIToken=${tokenId}=${secret}`,
        );
      }
    return loaded;
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    const { session } = this.options;
    switch (path) {
      case "/v1/owner/vault/status":
        return session.state();
      case "/v1/owner/vault/lock":
        session.lock("manual");
        return session.state();
      case "/v1/owner/vault/elevate": {
        // Re-entering the password is the step-up; it also unlocks if needed.
        await stepUp(input.password);
        if (typeof input.password !== "string")
          throw new HomectlError(2, "password is required");
        await session.elevate(passwordSource(input.password));
        const loaded = await this.loadKeys(true);
        return { ...session.state(), adminKeysLoaded: loaded };
      }
      default:
        return undefined;
    }
  }
}
