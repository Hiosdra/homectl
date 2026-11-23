// SecretBroker: the agent asks for a secret, the owner types it into a private
// form, and the agent only ever receives an opaque, non-bearer reference plus a
// status. Values exist in memory for one absolute hour from provide time, or in
// the encrypted vault when explicitly saved. They are never written to history,
// views or errors.

import { createHash } from "node:crypto";
import type { SecretDestination, SecretRequestState } from "../core/contracts";
import { HomectlError } from "../types";
import {
  cloneDestination,
  destinationKey,
  normalizeDestination,
} from "./destinations";
import { SecretGrants } from "./grants";
import {
  type BrokerRequestView,
  MAX_HISTORY_RECORDS,
  MAX_PENDING_PER_CLIENT,
  SECRET_VALUE_TTL_MS,
  type SecretBrokerOptions,
  type SecretEntry as Entry,
  type SecretHistoryAction,
  type SecretHistoryRecord,
  type SecretProvideOptions,
  type SecretRawHandoffOptions,
  type SecretRequestInput,
  type SecretRetention,
  type SecretUseGrant,
  type SecretUseOptions,
  type VaultPort,
} from "./types";
import {
  normalizeFields,
  refusal,
  usageError,
  validateAdmin,
  validateClient,
  validatePurpose,
  validateRequestTtl,
  validateSaveName,
  validateSecretId,
  validateTask,
  validateValues,
} from "./validation";

// Fixed messages. Error text never reveals which part of a lookup failed.
const NOT_FOUND = "secret request not found";
const NOT_USABLE = "secret reference is not usable";
const MISMATCH_CLIENT = "requester does not match the secret request";
const MISMATCH_DESTINATION = "destination does not match the secret request";

function reuseBinding(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const defaultRandom = (bytes: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(bytes));

export class SecretBroker {
  private readonly now: () => number;
  private readonly vault: VaultPort | undefined;
  private readonly random: (bytes: number) => Uint8Array;
  private readonly knownHost: (host: string) => boolean;
  private readonly grants: SecretGrants;
  private readonly entries = new Map<string, Entry>();
  private readonly byRef = new Map<string, Entry>();
  private readonly journal: SecretHistoryRecord[] = [];
  // Bumped by lock(). A provide that spans a lock must not store values.
  private epoch = 0;

  constructor(options: SecretBrokerOptions) {
    this.now = options.now;
    this.knownHost = options.knownHost;
    this.vault = options.vault;
    this.random = options.random ?? defaultRandom;
    this.grants = new SecretGrants(options.knownHost);
  }

  get canSave(): boolean {
    return this.vault !== undefined;
  }

  request(input: SecretRequestInput): BrokerRequestView {
    this.sweep();
    const client = validateClient(input.client);
    const task = validateTask(input.task);
    const purpose = validatePurpose(input.purpose);
    const fields = normalizeFields(input.fields);
    const destination = normalizeDestination(input.destination, this.knownHost);
    const ttl = validateRequestTtl(input.requestTtlMs);
    const admin = validateAdmin(input.admin);
    // Match the exact requester, destination and field types.
    const dedupeKey = JSON.stringify([
      client,
      task ?? null,
      destinationKey(destination),
      input.targetBinding ?? null,
      fields.map((field) => `${field.name}:${field.kind}`).sort(),
      admin,
    ]);
    for (const entry of this.entries.values()) {
      if (
        entry.dedupeKey === dedupeKey &&
        (entry.state === "pending" ||
          (entry.state === "provided" && entry.reusable))
      )
        return this.view(entry);
    }
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.client === client && entry.state === "pending") pending += 1;
    }
    if (pending >= MAX_PENDING_PER_CLIENT)
      throw refusal("too many pending secret requests for this client");
    const reusable = this.vault?.findReuse?.(reuseBinding(dedupeKey));
    const now = this.now();
    const entry: Entry = {
      id: this.token("", 16, (value) => this.entries.has(value)),
      client,
      task,
      purpose,
      destination,
      fields,
      admin,
      targetBinding: input.targetBinding,
      dedupeKey,
      createdAt: now,
      requestExpiresAt: now + ttl,
      state: "pending",
      busy: false,
    };
    this.entries.set(entry.id, entry);
    this.record("requested", entry);
    if (reusable !== undefined && !this.grants.isRevoked(reusable))
      this.markProvided(entry, "saved", reusable, true);
    return this.view(entry);
  }

  async provide(
    id: string,
    values: unknown,
    options: SecretProvideOptions,
  ): Promise<BrokerRequestView> {
    this.sweep();
    const entry = this.requireEntry(id);
    this.assertPending(entry);
    const copy = validateValues(entry.fields, values);
    if (options.retention !== "ephemeral" && options.retention !== "saved")
      throw usageError("retention must be ephemeral or saved");
    const saveName =
      options.retention === "saved"
        ? validateSaveName(options.saveName)
        : undefined;
    const vault = this.vault;
    if (options.retention === "saved" && !vault)
      throw usageError("saved retention needs the vault");
    const reuse = options.reuse === true;
    if (
      reuse &&
      (options.retention !== "saved" ||
        !vault?.findReuse ||
        entry.admin ||
        entry.destination.kind === "vault-only" ||
        entry.fields.some((field) => field.kind === "ssh-key"))
    )
      throw refusal("This secret cannot be saved for automatic reuse");
    entry.busy = true;
    const epoch = this.epoch;
    try {
      let secretId: string | undefined;
      if (options.retention === "saved" && vault && saveName !== undefined) {
        // Meta carries no values. A failed save leaves the request pending.
        secretId = await vault.save(
          saveName,
          { ...copy },
          {
            client: entry.client,
            task: entry.task,
            destination: cloneDestination(entry.destination),
            fields: entry.fields.map((field) => field.name),
            createdAt: entry.createdAt,
            ...(reuse ? { reuseBinding: reuseBinding(entry.dedupeKey) } : {}),
          },
        );
      }
      if (epoch !== this.epoch)
        throw refusal(
          "vault was locked while the secret was being saved; nothing was kept in memory",
        );
      entry.values = copy;
      entry.valueExpiresAt = this.now() + SECRET_VALUE_TTL_MS;
      this.markProvided(entry, options.retention, secretId, reuse);
    } finally {
      entry.busy = false;
    }
    return this.view(entry);
  }

  status(id: string, client: string): BrokerRequestView {
    this.sweep();
    return this.view(this.requireOwnEntry(id, client));
  }

  decline(id: string): BrokerRequestView {
    this.sweep();
    const entry = this.requireEntry(id);
    this.assertPending(entry);
    entry.state = "declined";
    this.record("declined", entry);
    return this.view(entry);
  }

  cancel(id: string, client: string): BrokerRequestView {
    this.sweep();
    const entry = this.requireOwnEntry(id, client);
    if (entry.busy) throw refusal("secret request is being provided");
    if (entry.state === "pending") {
      entry.state = "cancelled";
    } else if (entry.state === "provided") {
      this.retire(entry, "cancelled");
    } else {
      throw refusal("secret request cannot be cancelled");
    }
    this.record("cancelled", entry);
    return this.view(entry);
  }

  revoke(ref: string): void {
    this.sweep();
    const entry = this.byRef.get(ref);
    if (entry?.state !== "provided") throw refusal(NOT_USABLE);
    this.retire(entry, "revoked");
    this.record("revoked", entry);
  }

  savedGrants() {
    return this.vault?.listReuse?.() ?? [];
  }

  async revokeSavedGrant(id: string): Promise<void> {
    if (!this.vault?.revokeReuse)
      throw refusal("Saved secret grants are unavailable");
    validateSecretId(id);
    this.grants.retire(id);
    for (const entry of this.entries.values()) {
      if (entry.savedSecretId !== id || entry.state !== "provided") continue;
      this.retire(entry, "revoked");
      this.record("revoked", entry);
    }
    await this.vault.revokeReuse(id);
  }

  lock(): void {
    this.epoch += 1;
    for (const entry of this.entries.values()) {
      if (entry.state !== "provided" || entry.values === undefined) continue;
      if (entry.retention === "ephemeral") {
        this.retire(entry, "revoked");
        this.record("revoked", entry);
      } else {
        entry.values = undefined;
      }
    }
  }

  sweep(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (
        entry.state === "pending" &&
        !entry.busy &&
        now >= entry.requestExpiresAt
      ) {
        entry.state = "expired";
        this.record("expired", entry);
        continue;
      }
      if (
        entry.state === "provided" &&
        entry.values !== undefined &&
        entry.valueExpiresAt !== undefined &&
        now >= entry.valueExpiresAt
      ) {
        entry.values = undefined;
        if (entry.retention === "ephemeral") {
          entry.state = "expired";
          this.record("expired", entry);
        }
      }
    }
  }

  // ------------------------------------------------------------ release

  async use(
    ref: string,
    options: SecretUseOptions,
  ): Promise<Record<string, string>> {
    this.sweep();
    const entry = this.byRef.get(ref);
    if (entry?.state !== "provided") throw refusal(NOT_USABLE);
    const destination = this.matchDestination(options.destination);
    const sameRequester =
      entry.client === options.client && entry.task === options.task;
    if (entry.targetBinding !== options.targetBinding)
      throw refusal(
        "The destination configuration changed. Request the secret again",
      );
    const sameTarget =
      destinationKey(entry.destination) === destinationKey(destination);
    if (sameRequester && sameTarget) {
      const values = await this.valuesFor(entry);
      if (!values) throw refusal(NOT_USABLE);
      this.record("used", entry);
      return values;
    }
    if (
      entry.savedSecretId !== undefined &&
      this.grants.covers(entry.savedSecretId, options.client, destination)
    ) {
      const values = await this.loadSaved(entry.savedSecretId);
      if (!values || entry.state !== "provided") throw refusal(NOT_USABLE);
      this.record("used", entry);
      return values;
    }
    throw refusal(sameRequester ? MISMATCH_DESTINATION : MISMATCH_CLIENT);
  }

  grantUse(secretId: string, scope: SecretUseGrant): void {
    this.grants.grant(secretId, scope);
  }

  async useSaved(
    secretId: string,
    options: { client: string; destination: SecretDestination },
  ): Promise<Record<string, string>> {
    this.sweep();
    const id = validateSecretId(secretId);
    const destination = this.matchDestination(options.destination);
    if (!this.grants.covers(id, options.client, destination))
      throw refusal("no saved-secret grant covers this use");
    const values = await this.loadSaved(id);
    if (!values) throw refusal(NOT_USABLE);
    this.append({ at: this.now(), client: options.client, action: "used" });
    return values;
  }

  async rawHandoff(
    ref: string,
    options: SecretRawHandoffOptions,
  ): Promise<Record<string, string>> {
    this.sweep();
    if (options.stepUp !== true || options.warningAcknowledged !== true)
      throw refusal("raw handoff needs step-up and an acknowledged warning");
    const entry = this.byRef.get(ref);
    if (entry?.state !== "provided") throw refusal(NOT_USABLE);
    if (entry.client !== options.client) throw refusal(MISMATCH_CLIENT);
    if (entry.admin) throw refusal("raw handoff is refused for admin requests");
    if (entry.fields.some((field) => field.kind === "ssh-key"))
      throw refusal("raw handoff is refused for ssh-key fields");
    const values = await this.valuesFor(entry);
    if (!values) throw refusal(NOT_USABLE);
    this.record("raw-handoff", entry);
    return values;
  }

  pending(): BrokerRequestView[] {
    this.sweep();
    return [...this.entries.values()]
      .filter((entry) => entry.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this.view(entry));
  }

  history(): SecretHistoryRecord[] {
    return this.journal.map((item) => ({ ...item }));
  }

  private markProvided(
    entry: Entry,
    retention: SecretRetention,
    secretId: string | undefined,
    reusable: boolean,
  ): void {
    entry.retention = retention;
    entry.savedSecretId = secretId;
    entry.reusable = reusable;
    entry.ref = this.token("sref_", 18, (value) => this.byRef.has(value));
    this.byRef.set(entry.ref, entry);
    entry.state = "provided";
    this.record("provided", entry);
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw refusal(NOT_FOUND);
    return entry;
  }

  private requireOwnEntry(id: string, client: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.client !== client) throw refusal(NOT_FOUND);
    return entry;
  }

  private assertPending(entry: Entry): void {
    if (entry.busy) throw refusal("secret request is being provided");
    if (entry.state !== "pending")
      throw refusal("secret request is not pending");
  }

  private matchDestination(value: unknown): SecretDestination {
    try {
      return normalizeDestination(value, this.knownHost);
    } catch {
      throw refusal(MISMATCH_DESTINATION);
    }
  }

  private async loadSaved(
    secretId: string,
  ): Promise<Record<string, string> | undefined> {
    if (!this.vault || this.grants.isRevoked(secretId)) return undefined;
    const loaded = await this.vault.load(secretId);
    if (!loaded || this.grants.isRevoked(secretId)) return undefined;
    return { ...loaded };
  }

  private async valuesFor(
    entry: Entry,
  ): Promise<Record<string, string> | undefined> {
    if (entry.values !== undefined) return { ...entry.values };
    if (entry.savedSecretId === undefined) return undefined;
    const loaded = await this.loadSaved(entry.savedSecretId);
    return entry.state === "provided" ? loaded : undefined;
  }

  private retire(entry: Entry, state: SecretRequestState): void {
    entry.values = undefined;
    entry.state = state;
    if (
      entry.savedSecretId !== undefined &&
      (!entry.reusable || state === "revoked")
    )
      this.grants.retire(entry.savedSecretId);
  }

  private token(
    prefix: string,
    bytes: number,
    taken: (value: string) => boolean,
  ): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = this.random(bytes);
      if (raw.length !== bytes)
        throw new HomectlError(5, "random source failed");
      const value = `${prefix}${Buffer.from(raw).toString("base64url")}`;
      if (!taken(value)) return value;
    }
    throw new HomectlError(5, "could not allocate a secret identifier");
  }

  private view(entry: Entry): BrokerRequestView {
    const view: BrokerRequestView = {
      id: entry.id,
      client: entry.client,
      purpose: entry.purpose,
      destination: cloneDestination(entry.destination),
      fields: entry.fields.map((field) => ({ ...field })),
      state: entry.state,
      createdAt: entry.createdAt,
      expiresAt: entry.requestExpiresAt,
    };
    if (entry.task !== undefined) view.task = entry.task;
    if (entry.retention !== undefined) view.retention = entry.retention;
    if (entry.ref !== undefined) view.ref = entry.ref;
    if (entry.valueExpiresAt !== undefined)
      view.valueExpiresAt = entry.valueExpiresAt;
    return view;
  }

  private record(action: SecretHistoryAction, entry: Entry): void {
    const item: SecretHistoryRecord = {
      at: this.now(),
      requestId: entry.id,
      client: entry.client,
      action,
    };
    if (entry.ref !== undefined) item.ref = entry.ref;
    this.append(item);
  }

  private append(item: SecretHistoryRecord): void {
    this.journal.push(item);
    if (this.journal.length > MAX_HISTORY_RECORDS)
      this.journal.splice(0, this.journal.length - MAX_HISTORY_RECORDS);
  }
}
