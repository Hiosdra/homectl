import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DeviceKey, loadOrCreateDeviceKey } from "../control/device-key";
import { controlStateDirectory } from "../control/engine";
import { appendLocalAudit } from "../control/journal";
import { normalizeAuditArgv } from "../control/redact";
import { loadInventory, parseInventory, saveInventory } from "../inventory";
import { execute, writeSSHConfig } from "../operations";
import { privateDirectory, protect } from "../platform";
import { planExecution } from "../policies";
import { SavedCommandStore } from "../saved-commands";
import {
  lockSession,
  sessionConfig,
  sessionStatus,
  unlockSession,
} from "../session";
import { keyReference } from "../session/keys";
import { doctor } from "../setup";
import { HomectlError, type Inventory, type Machine } from "../types";
import { savePeerSyncRecords } from "./apply-sync-records";
import { peerCommand } from "./command";
import {
  type Envelope,
  equal,
  open,
  proof,
  seal,
  transportKey,
} from "./crypto";
import { collectHostKeys, validateHostKeys } from "./hostkeys";
import { safeVersion, validatePermissions } from "./hub-helpers";
import {
  createPair,
  identity,
  joinPair,
  type Pair,
  paired,
  pairProof,
  pairStart,
} from "./pairing";
import {
  loadState,
  type Peer,
  type PeerState,
  type Permissions,
  peerPath,
  saveState,
  type Version,
} from "./store";
import {
  type Choice,
  capture,
  filterSnapshotRecords,
  hash,
  merge,
  PEER_FEATURES,
  readSyncOffer,
  readSyncSnapshot,
  sanitizeSyncRecords,
  syncSnapshotEnvelope,
  syncSnapshotResponse,
} from "./sync";
import { type Credential, credentialPublicKey, Vault } from "./vault";
export function peerAddress(value: string): string {
  const url = new URL(value);
  const ip = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !isIP(ip)
  )
    throw new HomectlError(
      2,
      "Use a peer's direct LAN IP and port, e.g. http://192.168.1.10:7448",
    );
  const private4 =
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const private6 = ip === "::1" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  if (!private4 && !private6)
    throw new HomectlError(2, "Only local network addresses are supported");
  return url.origin;
}
async function post(
  address: string,
  path: string,
  value: unknown,
): Promise<unknown> {
  const r = await fetch(`${peerAddress(address)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const bytes = await r.text();
  if (bytes.length > 24 * 1024 * 1024)
    throw new HomectlError(2, "Peer response too large");
  if (!r.ok)
    throw new HomectlError(
      5,
      "Peer refused the request; inspect its local panel",
    );
  return JSON.parse(bytes);
}
type Operation = {
  id: string;
  peerId: string;
  operationId: string;
  host: string;
  argv: string[];
  impact?: string;
  approval: string;
  expiresAt: number;
  result?: unknown;
  state: "pending" | "done" | "rejected";
};
type Pending = {
  id: string;
  peerId: string;
  base: string;
  records: Record<string, Version>;
  local: Record<string, Version>;
  remoteVaultUnlocked?: boolean;
  peerFeatures: string[];
  issues: { id: string; reason: string }[];
  expiresAt: number;
};
export class Hub {
  state!: PeerState;
  vault!: Vault;
  savedCommands!: SavedCommandStore;
  pair?: Pair;
  pending = new Map<string, Pending>();
  operations = new Map<string, Operation>();
  device?: DeviceKey;
  // Serves control-plane logs to authenticated peers with a sync grant (ADR-0002 stage c).
  controlExchange?: (peer: Peer, payload: unknown) => Promise<unknown>;
  private challenges = new Map<
    string,
    {
      expiresAt: number;
      peerId: string;
      privateKey: KeyObject;
      publicKey: string;
    }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private vaultExpiry?: ReturnType<typeof setTimeout>;
  constructor(
    readonly inventoryPath: string,
    readonly configPath: string,
    readonly address: string,
  ) {}
  async init() {
    this.state = await loadState(peerPath(this.inventoryPath));
    this.savedCommands = SavedCommandStore.forInventory(this.inventoryPath);
    const inv = await loadInventory(this.inventoryPath);
    this.vault = new Vault(sessionConfig(inv, this.inventoryPath).database);
    this.device = await loadOrCreateDeviceKey(
      controlStateDirectory(this.inventoryPath),
    );
    return this;
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async save() {
    await saveState(peerPath(this.inventoryPath), this.state);
  }
  localIdentity() {
    return { ...identity(this.state), signingKey: this.device?.publicKey };
  }
  async status() {
    if (this.pair && this.pair.expiresAt <= Date.now()) {
      this.pair.key?.fill(0);
      this.pair = undefined;
    }
    for (const [id, p] of this.pending)
      if (p.expiresAt < Date.now()) this.pending.delete(id);
    return {
      device: this.localIdentity(),
      session: await sessionStatus(this.inventoryPath),
      vaultUnlocked: this.vault.unlocked,
      vaultExists: await Bun.file(this.vault.path).exists(),
      operations: [...this.operations.values()]
        .filter((o) => o.state === "pending" && o.expiresAt > Date.now())
        .map(({ approval, result, ...o }) => ({
          ...o,
          peerName: this.state.peers[o.peerId]?.name,
        })),
      inventory: await loadInventory(this.inventoryPath),
      peers: Object.values(this.state.peers).map(({ key, ...p }) => p),
      pair: this.pair
        ? {
            id: this.pair.id,
            code: this.pair.code,
            sas: this.pair.sas,
            remote: this.pair.remote,
            expiresAt: this.pair.expiresAt,
            localConfirmed: this.pair.localConfirmed,
            remoteConfirmed: this.pair.remoteConfirmed,
          }
        : null,
    };
  }
  async unlock(password: string, create = false) {
    if (typeof password !== "string" || !password || password.length > 1024)
      throw new HomectlError(2, "Enter the database password");
    await this.vault.unlock(password, create);
    const inv = await loadInventory(this.inventoryPath);
    let state: { expiresAt?: number | null } = {
      expiresAt: Date.now() + 24 * 3600_000,
    };
    try {
      if (Object.values(inv.machines).some((m) => m.auth))
        state = await unlockSession(
          inv,
          this.inventoryPath,
          async () => password,
        );
    } catch (e) {
      this.vault.lock();
      throw e;
    }
    clearTimeout(this.vaultExpiry);
    const expiresAt = state.expiresAt;
    const schedule = () => {
      if (expiresAt === null) return;
      const remaining = (expiresAt ?? 0) - Date.now();
      if (remaining <= 0) {
        void this.lock();
        return;
      }
      this.vaultExpiry = setTimeout(
        schedule,
        Math.min(remaining, 2_147_483_647),
      );
      this.vaultExpiry.unref();
    };
    schedule();
    return { unlocked: true };
  }
  async lock() {
    clearTimeout(this.vaultExpiry);
    this.vault.lock();
    for (const [id, r] of Object.entries(this.state.records))
      if (
        id.startsWith("credential:") &&
        r.value !== null &&
        !(typeof r.value === "object" && "fingerprint" in r.value)
      )
        r.value = { fingerprint: hash(r.value) };
    this.pending.clear();
    await lockSession(this.inventoryPath);
    return { unlocked: false };
  }
  async openPair() {
    this.pair?.key?.fill(0);
    this.pair = createPair();
    return this.status();
  }
  async join(address: string, code: string) {
    this.pair?.key?.fill(0);
    this.pair = await joinPair(
      peerAddress(address),
      code,
      this.localIdentity(),
      (p, v) => post(address, p, v),
    );
    return this.status();
  }
  async confirm(permissions: Permissions) {
    const p = this.pair;
    if (!p?.key || !p.remote)
      throw new HomectlError(3, "No verified pairing awaiting confirmation");
    validatePermissions(permissions);
    p.permissions = permissions;
    p.localConfirmed = true;
    if (p.outgoing && p.address) {
      const result = (await post(p.address, "/pair/confirm", {
        id: p.id,
        envelope: seal(
          p.key,
          { identity: this.localIdentity(), address: this.address },
          `pair:${p.id}:confirm`,
        ),
      })) as { envelope: Envelope };
      const response = open<{ confirmed: boolean }>(
        p.key,
        result.envelope,
        `pair:${p.id}:confirmed`,
      );
      p.remoteConfirmed = response.confirmed;
    }
    if (p.localConfirmed && p.remoteConfirmed) {
      this.state.peers[p.remote.id] = paired(p);
      await this.save();
    }
    return this.status();
  }
  async pollPair() {
    const p = this.pair;
    if (
      p?.outgoing &&
      p.key &&
      p.address &&
      p.localConfirmed &&
      !p.remoteConfirmed
    ) {
      const result = (await post(p.address, "/pair/confirm", {
        id: p.id,
        envelope: seal(
          p.key,
          { identity: this.localIdentity(), address: this.address },
          `pair:${p.id}:confirm`,
        ),
      })) as { envelope: Envelope };
      p.remoteConfirmed = open<{ confirmed: boolean }>(
        p.key,
        result.envelope,
        `pair:${p.id}:confirmed`,
      ).confirmed;
      if (p.remoteConfirmed && p.remote) {
        this.state.peers[p.remote.id] = paired(p);
        await this.save();
      }
    }
    return this.status();
  }
  async pairingRoute(path: string, value: Record<string, unknown>) {
    const p = this.pair;
    if (!p || p.outgoing || p.expiresAt < Date.now())
      throw new HomectlError(3, "Pairing is closed");
    if (path === "/pair/start") return pairStart(p, String(value.public));
    if (value.id !== p.id) throw new HomectlError(3, "Wrong pairing session");
    if (path === "/pair/proof")
      return pairProof(
        p,
        String(value.proof),
        value.envelope as Envelope,
        this.localIdentity(),
      );
    if (path === "/pair/confirm" && p.key && p.remote) {
      const v = open<{ identity: { id: string }; address: string }>(
        p.key,
        value.envelope as Envelope,
        `pair:${p.id}:confirm`,
      );
      if (v.identity.id !== p.remote.id)
        throw new HomectlError(3, "Peer identity changed");
      p.address = peerAddress(v.address);
      p.remoteConfirmed = true;
      if (p.localConfirmed) {
        this.state.peers[p.remote.id] = paired(p);
        await this.save();
      }
      return {
        envelope: seal(
          p.key,
          { confirmed: p.localConfirmed },
          `pair:${p.id}:confirmed`,
        ),
      };
    }
    throw new HomectlError(2, "Unknown pairing action");
  }
  challenge(peerId: string) {
    if (!this.state.peers[peerId]) throw new HomectlError(3, "Unknown peer");
    for (const [id, c] of this.challenges)
      if (c.expiresAt < Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 128)
      throw new HomectlError(3, "Too many peer challenges");
    const id = randomUUID();
    const pair = generateKeyPairSync("x25519");
    const publicKey = pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    this.challenges.set(id, {
      peerId,
      expiresAt: Date.now() + 30_000,
      privateKey: pair.privateKey,
      publicKey,
    });
    return {
      challenge: id,
      publicKey,
      proof: proof(
        Buffer.from(this.state.peers[peerId]?.key ?? "", "hex"),
        `challenge-v1:${peerId}:${this.state.id}:${id}:${publicKey}`,
      ),
    };
  }
  async peerRequest(peerId: string, action: string, payload: unknown) {
    const peer = this.state.peers[peerId];
    if (!peer) throw new HomectlError(2, "Unknown peer");
    const challengeReply = (await post(peer.address, "/peer/challenge", {
      id: this.state.id,
    })) as { challenge: string; publicKey: string; proof: string };
    const { challenge, publicKey } = challengeReply;
    if (
      !/^[a-f0-9-]{36}$/.test(challenge) ||
      !equal(
        challengeReply.proof,
        proof(
          Buffer.from(peer.key, "hex"),
          `challenge-v1:${this.state.id}:${peerId}:${challenge}:${publicKey}`,
        ),
      )
    )
      throw new HomectlError(3, "Peer challenge authentication failed");
    const pair = generateKeyPairSync("x25519");
    const remoteKey = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (remoteKey.asymmetricKeyType !== "x25519")
      throw new HomectlError(3, "Unsupported peer key");
    const clientKey = pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const requestId = randomUUID();
    const context = `peer-v1:${this.state.id}:${peerId}:${requestId}:${challenge}:${publicKey}:${clientKey}`;
    const secret = diffieHellman({
      privateKey: pair.privateKey,
      publicKey: remoteKey,
    });
    const key = transportKey(secret, peer.key, context);
    secret.fill(0);
    try {
      const result = (await post(peer.address, "/peer/message", {
        id: this.state.id,
        requestId,
        challenge,
        clientKey,
        envelope: seal(key, { action, payload }, `${context}:request`),
      })) as { envelope: Envelope };
      return open<unknown>(key, result.envelope, `${context}:response`);
    } finally {
      key.fill(0);
    }
  }
  async message(value: {
    id: string;
    requestId: string;
    challenge: string;
    envelope: Envelope;
    clientKey: string;
  }) {
    const peer = this.state.peers[value.id];
    const c = this.challenges.get(value.challenge);
    this.challenges.delete(value.challenge);
    if (
      !peer ||
      !c ||
      c.peerId !== value.id ||
      c.expiresAt < Date.now() ||
      !/^[a-f0-9-]{36}$/.test(value.requestId)
    )
      throw new HomectlError(3, "Unknown peer or expired/replayed request");
    const remoteKey = createPublicKey({
      key: Buffer.from(value.clientKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (remoteKey.asymmetricKeyType !== "x25519")
      throw new HomectlError(3, "Unsupported peer key");
    const context = `peer-v1:${value.id}:${this.state.id}:${value.requestId}:${value.challenge}:${c.publicKey}:${value.clientKey}`;
    const secret = diffieHellman({
      privateKey: c.privateKey,
      publicKey: remoteKey,
    });
    const key = transportKey(secret, peer.key, context);
    secret.fill(0);
    try {
      const request = open<{ action: string; payload: unknown }>(
        key,
        value.envelope,
        `${context}:request`,
      );
      const result = await this.remoteAction(
        peer,
        request.action,
        request.payload,
      );
      return { envelope: seal(key, result, `${context}:response`) };
    } finally {
      key.fill(0);
    }
  }
  async snapshot(forWire = true, features: readonly string[] = PEER_FEATURES) {
    const inv = await loadInventory(this.inventoryPath);
    const values: Record<string, unknown> = {};
    for (const [name, m] of Object.entries(inv.machines))
      if (m.transport === "ssh")
        values[`machine:${name}`] = {
          name,
          ...m,
          auth: m.auth ? { type: m.auth.type, entry: m.auth.entry } : undefined,
        };
    for (const [name, p] of Object.entries(inv.providers ?? {}))
      values[`provider:${name}`] = { name, ...p };
    const savedCommands = await this.savedCommands.listWithIssues();
    const invalidSavedCommandIds = new Set(
      savedCommands.invalid.map((item) => `saved-command:${item.id}`),
    );
    for (const command of savedCommands.commands)
      values[`saved-command:${command.id}`] = command;
    const prefixes = ["machine:", "provider:", "saved-command:"];
    if (this.vault.unlocked) {
      prefixes.push("credential:");
      for (const [name, v] of Object.entries(this.vault.snapshot()))
        values[`credential:${name}`] = v;
    }
    const known = join(dirname(this.inventoryPath), "known_hosts");
    for (const source of [join(homedir(), ".ssh", "known_hosts"), known]) {
      try {
        Object.assign(
          values,
          collectHostKeys(await readFile(source, "utf8"), inv.machines),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    prefixes.push("hostkey:");
    capture(this.state, values, prefixes, invalidSavedCommandIds);
    await this.save();
    return filterSnapshotRecords(this.state.records, {
      forWire,
      vaultUnlocked: this.vault.unlocked,
      features,
      invalidSavedCommandIds,
    });
  }
  async preview(
    peerId: string,
    incoming: unknown,
    remoteVaultUnlocked?: boolean,
    supportedFeatures: string[] = [],
    priorIssues: { id: string; reason: string }[] = [],
  ) {
    const { records, issues: incomingIssues } = sanitizeSyncRecords(incoming);
    const issues = [...priorIssues, ...incomingIssues];
    if (
      Object.keys(records).some((k) => k.startsWith("credential:")) &&
      !this.vault.unlocked
    )
      throw new HomectlError(
        4,
        "Unlock the local vault before accepting credential changes",
      );
    const local = structuredClone(await this.snapshot(false));
    const result = merge(local, records, this.state.id);
    let remoteVaultNeeded = false;
    if (
      remoteVaultUnlocked === false &&
      this.vault.unlocked &&
      result.conflicts.length === 0
    ) {
      for (const [recordId, version] of Object.entries(result.records)) {
        if (
          !recordId.startsWith("machine:") ||
          !version.value ||
          typeof version.value !== "object"
        )
          continue;
        const machine = version.value as {
          name?: unknown;
          auth?: { entry?: unknown };
        };
        if (
          typeof machine.name !== "string" ||
          !/^[a-z][a-z0-9-]{0,62}$/.test(machine.name) ||
          typeof machine.auth?.entry !== "string"
        )
          continue;
        const credential =
          result.records[`credential:${machine.auth.entry}`]?.value;
        if (
          !credential &&
          !(await Bun.file(
            keyReference(machine.name, this.inventoryPath).public_key,
          ).exists())
        ) {
          remoteVaultNeeded = true;
          break;
        }
      }
    }
    const id = randomUUID();
    if (this.pending.size >= 16)
      throw new HomectlError(
        3,
        "Finish or cancel existing sync previews first",
      );
    this.pending.set(id, {
      id,
      peerId,
      base: hash(local),
      records: structuredClone(records),
      local,
      remoteVaultUnlocked,
      peerFeatures: supportedFeatures,
      issues,
      expiresAt: Date.now() + 300_000,
    });
    return {
      id,
      localName: this.state.name,
      remoteName: this.state.peers[peerId]?.name,
      ...(remoteVaultNeeded
        ? { blocker: { type: "remote_vault_locked" as const } }
        : {}),
      changes: Object.keys(records).filter(
        (k) => hash(local[k] ?? null) !== hash(records[k]),
      ),
      entries: Object.keys(records)
        .filter((id) => hash(local[id] ?? null) !== hash(records[id]))
        .map((id) => ({
          id,
          local: local[id] ? safeVersion(id, local[id] as Version) : null,
          remote: safeVersion(id, records[id] as Version),
        })),
      conflicts: result.conflicts.map((c) => ({
        ...c,
        local: safeVersion(c.id, c.local),
        remote: safeVersion(c.id, c.remote),
      })),
      issues,
    };
  }
  async beginSync(peerId: string) {
    const remote = await this.peerRequest(peerId, "snapshot", {
      version: 2,
      features: PEER_FEATURES,
    });
    const snapshot = readSyncSnapshot(remote);
    return this.serial(() =>
      this.preview(
        peerId,
        snapshot.records,
        snapshot.vaultUnlocked,
        snapshot.features,
      ),
    );
  }
  async syncReadiness(peerId: string) {
    const value = await this.peerRequest(peerId, "sync-readiness", {});
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { vaultUnlocked?: unknown }).vaultUnlocked !== "boolean"
    )
      throw new HomectlError(2, "Invalid peer sync readiness");
    return {
      vaultUnlocked: (value as { vaultUnlocked: boolean }).vaultUnlocked,
    };
  }
  async commit(id: string, choices: Record<string, Choice>, partial = false) {
    const p = this.pending.get(id);
    if (!p || p.expiresAt < Date.now())
      throw new HomectlError(3, "Sync preview expired; refresh it");
    const local = await this.snapshot(false);
    if (hash(local) !== p.base)
      throw new HomectlError(
        3,
        "Local data changed since preview; refresh before applying",
      );
    const result = merge(local, p.records, this.state.id, choices, partial);
    // A partial apply writes the routine clean changes only; the rest and any conflict keep the local value.
    if (result.conflicts.length && !partial)
      throw new HomectlError(4, "Resolve every conflict before applying");
    await this.applyRecords(result.records, p.remoteVaultUnlocked, p.local);
    this.pending.delete(id);
    return {
      applied: true,
      copies: result.copies,
      conflicts: result.conflicts.length,
    };
  }
  async syncCommit(
    id: string,
    choices: Record<string, Choice>,
    partial = false,
  ) {
    const p = this.pending.get(id);
    if (!p) throw new HomectlError(2, "Unknown sync preview");
    const peerId = p.peerId;
    const result = await this.serial(() => this.commit(id, choices, partial));
    // The remote peer also gets a local review; accepting a pair does not let
    // another machine silently overwrite this one's inventory or credentials.
    const snapshot = await this.serial(async () =>
      syncSnapshotEnvelope(
        await this.snapshot(true, p.peerFeatures),
        this.vault.unlocked,
      ),
    );
    const remote = await this.peerRequest(peerId, "offer", {
      ...snapshot,
      version: 2,
    });
    return { ...result, remoteReview: remote };
  }
  async applyRecords(
    records: Record<string, Version>,
    remoteVaultUnlocked?: boolean,
    expectedSavedCommands?: Record<string, { value: unknown | null }>,
  ) {
    const inv = await loadInventory(this.inventoryPath);
    const credentials: Record<string, Credential> = {};
    const names = new Set<string>();
    for (const [id, r] of Object.entries(records))
      if (
        this.vault.unlocked &&
        id.startsWith("credential:") &&
        r.value !== null
      ) {
        const v = structuredClone(r.value) as Credential;
        if (id.includes(":copy-")) {
          v.title = `homectl-copy-${id.slice(-36)}`;
          v.fields.Title = v.title;
        }
        credentials[v.title] = v;
      }
    const machines: Record<string, Machine> = {};
    const providers: NonNullable<Inventory["providers"]> = {};
    for (const [id, r] of Object.entries(records)) {
      if (r.value === null) continue;
      if (id.startsWith("machine:")) {
        const v = structuredClone(r.value) as Machine & { name: string };
        let name = v.name;
        if (id.includes(":copy-")) {
          name = `copy-${id.slice(-36)}`;
          v.ssh_alias = name;
        }
        if (names.has(name))
          throw new HomectlError(
            3,
            "Duplicate machine names; rename the conflicting copy",
          );
        names.add(name);
        delete (v as Partial<typeof v>).name;
        if (v.auth)
          v.auth = {
            ...keyReference(name, this.inventoryPath),
            entry: v.auth.entry,
          };
        machines[name] = v;
      }
      if (id.startsWith("provider:")) {
        const v = structuredClone(r.value) as NonNullable<
          Inventory["providers"]
        >[string] & { name: string };
        const name = id.includes(":copy-") ? `copy-${id.slice(-36)}` : v.name;
        delete (v as Partial<typeof v>).name;
        providers[name] = v;
      }
    }
    const next: Inventory = {
      ...inv,
      machines: {
        ...Object.fromEntries(
          Object.entries(inv.machines).filter(
            ([, m]) => m.transport === "local",
          ),
        ),
        ...machines,
      },
      providers,
    };
    parseInventory(JSON.stringify(next));
    for (const m of Object.values(machines))
      if (m.auth) {
        const c = credentials[m.auth.entry];
        if (!c && !(await Bun.file(m.auth.public_key).exists())) {
          if (!this.vault.unlocked)
            throw new HomectlError(
              4,
              "Unlock the local vault before accepting credential changes",
            );
          if (remoteVaultUnlocked === false)
            throw new HomectlError(
              4,
              "The other device's vault was locked when the devices were compared. Unlock it there and compare again.",
            );
          if (remoteVaultUnlocked === undefined)
            throw new HomectlError(
              5,
              "The other device does not report its vault state. Update homectl on that device and compare again.",
            );
          throw new HomectlError(
            5,
            `The credential for ${m.ssh_alias ?? "this machine"} is missing. Add the machine's credential to a vault and compare again.`,
          );
        }
        if (c) credentialPublicKey(c);
      }
    const trusted = Object.fromEntries(
      Object.entries(records)
        .filter(([id, r]) => id.startsWith("hostkey:") && r.value !== null)
        .map(([id, r]) => [id, String(r.value)]),
    );
    validateHostKeys(trusted, machines);
    await this.savedCommands.validateReplacement(
      records,
      expectedSavedCommands,
    );
    if (this.vault.unlocked) await this.vault.apply(credentials);
    await privateDirectory(join(dirname(this.inventoryPath), "public-keys"));
    for (const m of Object.values(machines))
      if (m.auth && credentials[m.auth.entry]) {
        await writeFile(
          m.auth.public_key,
          credentialPublicKey(credentials[m.auth.entry] as Credential),
          { mode: 0o600 },
        );
        await protect(m.auth.public_key);
      }
    const known = join(dirname(this.inventoryPath), "known_hosts");
    await privateDirectory(dirname(known));
    await writeFile(known, `${Object.values(trusted).join("\n")}\n`, {
      mode: 0o600,
    });
    await protect(known);
    if (await Bun.file(this.inventoryPath).exists()) {
      const backup = `${this.inventoryPath}.before-sync-${Date.now()}`;
      await copyFile(this.inventoryPath, backup);
      await protect(backup);
    }
    await lockSession(this.inventoryPath);
    await saveInventory(this.inventoryPath, next);
    await writeSSHConfig(this.configPath, next.machines);
    await savePeerSyncRecords(this, records, expectedSavedCommands);
  }
  async remoteAction(peer: Peer, action: string, payload: unknown) {
    if (action === "control-exchange") {
      if (!peer.permissions.sync)
        throw new HomectlError(3, "This peer has no sync grant");
      if (!this.controlExchange)
        throw new HomectlError(5, "Control sync is not running on this device");
      return this.controlExchange(peer, payload);
    }
    if (action === "sync-readiness") {
      if (!peer.permissions.sync)
        throw new HomectlError(3, "This peer has no sync grant");
      return { vaultUnlocked: this.vault.unlocked };
    }
    if (action === "snapshot" || action === "offer") {
      if (!peer.permissions.sync)
        throw new HomectlError(3, "This peer has no sync grant");
      const input =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      if (action === "snapshot") {
        return syncSnapshotResponse(input, this.vault.unlocked, (features) =>
          this.snapshot(true, features),
        );
      }
      const offer = readSyncOffer(input);
      return this.preview(
        peer.id,
        offer.records,
        offer.vaultUnlocked,
        offer.features,
      );
    }
    if (action === "status") {
      if (!peer.permissions.diagnostics)
        throw new HomectlError(3, "This peer has no diagnostics grant");
      const s = await this.status();
      return {
        device: s.device,
        session: s.session,
        hosts: Object.entries(s.inventory.machines).map(([name, m]) => ({
          name,
          description: m.description,
          access: m.access,
        })),
      };
    }
    if (action === "doctor") {
      if (!peer.permissions.diagnostics)
        throw new HomectlError(3, "No diagnostics grant");
      return doctor(
        await loadInventory(this.inventoryPath),
        this.configPath,
        (payload as { host?: string }).host,
      );
    }
    if (action === "exec") {
      return peerCommand(this, peer, payload);
    }
    if (action === "operation-status") {
      const o = this.operations.get((payload as { id: string }).id);
      if (!o || o.peerId !== peer.id || o.expiresAt < Date.now())
        throw new HomectlError(3, "Operation unavailable");
      return { id: o.id, state: o.state, result: o.result };
    }
    throw new HomectlError(2, "Unknown peer action");
  }
  async decideOperation(id: string, approved: boolean) {
    const o = this.operations.get(id);
    if (!o || o.state !== "pending" || o.expiresAt < Date.now())
      throw new HomectlError(3, "Operation approval expired or already used");
    if (!approved) {
      o.state = "rejected";
      const peer = this.state.peers[o.peerId];
      try {
        await appendLocalAudit(this.inventoryPath, {
          event: "command.refused",
          op: "execute",
          operationId: o.operationId,
          client: "local-operator",
          ...(peer ? { device: peer.id, deviceName: peer.name } : {}),
          host: o.host,
          argv: normalizeAuditArgv(o.argv),
          policyDecision: "refused",
          reason: "peer-operation-rejected",
        });
      } catch {
        console.warn(
          "Could not record the rejected peer operation in the audit journal.",
        );
      }
      return { rejected: true };
    }
    const peer = this.state.peers[o.peerId];
    const inv = await loadInventory(this.inventoryPath);
    const machine = inv.machines[o.host];
    if (
      !peer ||
      !machine ||
      !peer.permissions.operations.includes(o.host) ||
      (machine.transport === "local" && !peer.permissions.administer)
    )
      throw new HomectlError(3, "Peer grant changed; operation refused");
    const plan = planExecution(o.host, machine, o.argv, o.impact);
    if (plan.approval !== o.approval)
      throw new HomectlError(
        3,
        "Machine or command changed; request a fresh review",
      );
    if (
      !this.vault.unlocked &&
      !(await sessionStatus(this.inventoryPath)).unlocked
    )
      throw new HomectlError(
        5,
        "Unlock this execution device locally before approving a peer operation",
      );
    o.state = "done";
    try {
      o.result = await execute(o.host, machine, o.argv, {
        configPath: this.configPath,
        approval: o.approval,
        approvalContext: "peer",
        impact: o.impact,
        audit: {
          inventoryPath: this.inventoryPath,
          ...(peer ? { device: peer.id, deviceName: peer.name } : {}),
          approver: "local-operator",
          operationId: o.operationId,
        },
      });
      return { executed: true, result: o.result };
    } catch (e) {
      o.result = {
        error:
          e instanceof HomectlError
            ? e.message
            : "Operation failed; details suppressed",
      };
      throw e;
    }
  }
  async permissions(id: string, p: Permissions, address?: string) {
    validatePermissions(p);
    const peer = this.state.peers[id];
    if (!peer) throw new HomectlError(2, "Unknown peer");
    peer.permissions = p;
    if (address) peer.address = peerAddress(address);
    await this.save();
    return { saved: true };
  }
  async forget(id: string) {
    delete this.state.peers[id];
    for (const [key, o] of this.operations)
      if (o.peerId === id) this.operations.delete(key);
    for (const [k, p] of this.pending)
      if (p.peerId === id) this.pending.delete(k);
    await this.save();
    return {
      forgotten: true,
      note: "Previously copied SSH keys remain valid until rotated on the hosts",
    };
  }
}
