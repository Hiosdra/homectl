// Central secret request intents (homelab #21 S1-S2, D8).
// Metadata (destination, fields, untrusted purpose, non-secret status) is
// mirrored from linked clients. Owner-entered secret values NEVER touch
// workspace-server.json, audit logs or events: they live only in
// SecretIntentVault in memory until delivered once over the encrypted sync
// channel, expired, or wiped on vault lock / shutdown.
import { randomUUID } from "node:crypto";
import type { SecretDestination, SecretField } from "../core/contracts";
import { HomectlError } from "../types";
import { FINISHED, INTENT_MS } from "./intents";
import type {
  IntentStatus,
  LinkedClient,
  ServerState,
  ServerStateFile,
} from "./state";
import { linked } from "./state";
import * as v from "./validate";

export const MAX_PENDING_SECRETS = 100;
const MAX_SECRET_FIELDS = 16;
const MAX_SECRET_VALUE_CHARS = 65_536;
const MAX_SECRET_INTENTS = 200;
const SECRET_INTENT_MS = 60 * 60_000;

export interface PendingSecretSummary {
  id: string;
  client: string;
  task?: string;
  purpose: { untrusted: string };
  destination: SecretDestination;
  fields: SecretField[];
  admin: boolean;
  canSave: boolean;
  requestExpiresAt: number;
}

export type SecretIntentAction = "provide" | "decline";

// Persisted non-secret record of a central secret decision. Never carries values.
export interface SecretIntentRecord {
  id: string;
  secretId: string;
  action: SecretIntentAction;
  status: IntentStatus;
  createdAt: number;
  expiresAt: number;
  reason?: string;
}

// In-memory-only payload held on the server until delivered once to the client.
export interface SecretProvidePayload {
  values: Record<string, string>;
  retention: "ephemeral" | "saved";
  saveName?: string;
  reuse?: boolean;
}

// Delivered over the authenticated E2E encrypted sync channel to the client.
export interface ServerSecretIntent {
  id: string;
  secretId: string;
  action: SecretIntentAction;
  expiresAt: number;
  values?: Record<string, string>;
  retention?: "ephemeral" | "saved";
  saveName?: string;
  reuse?: boolean;
}

export interface SecretIntentView {
  id: string;
  action: SecretIntentAction;
  status: IntentStatus;
  reason?: string;
  expiresAt: number;
}

export class SecretIntentVault {
  private readonly items = new Map<
    string,
    { expiresAt: number; payload: SecretProvidePayload }
  >();

  put(id: string, expiresAt: number, payload: SecretProvidePayload): void {
    this.items.set(id, { expiresAt, payload });
  }

  get(id: string, now: number): SecretProvidePayload | undefined {
    const entry = this.items.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.items.delete(id);
      return undefined;
    }
    return entry.payload;
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  sweep(now: number): void {
    for (const [id, entry] of this.items)
      if (entry.expiresAt <= now) this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }
}

function parseField(value: unknown): SecretField {
  const field = v.record(value, "secret field");
  const kind = field.kind;
  if (
    kind !== "password" &&
    kind !== "token" &&
    kind !== "ssh-key" &&
    kind !== "text"
  )
    v.fail("secret field kind is invalid");
  return {
    name: v.text(field.name, "field name", 64),
    kind,
    label: v.text(field.label ?? field.name, "field label", 128),
  };
}

function parseDestination(value: unknown): SecretDestination {
  const dest = v.record(value, "secret destination");
  switch (dest.kind) {
    case "ssh-stdin":
      return {
        kind: "ssh-stdin",
        host: v.text(dest.host, "host", 255),
        argv: v.list(dest.argv, "argv", 64, (arg) => v.text(arg, "arg", 1024)),
      };
    case "target-file":
      return {
        kind: "target-file",
        host: v.text(dest.host, "host", 255),
        path: v.text(dest.path, "path", 1024),
        mode: v.text(dest.mode, "mode", 8),
      };
    case "http-header":
      return {
        kind: "http-header",
        url: v.text(dest.url, "url", 2048),
        header: v.text(dest.header, "header", 128),
        ...(dest.scheme === undefined
          ? {}
          : { scheme: v.text(dest.scheme, "scheme", 64) }),
      };
    case "vault-only":
      return { kind: "vault-only" };
    default:
      v.fail("secret destination kind is invalid");
  }
}

export function parsePendingSecrets(value: unknown): PendingSecretSummary[] {
  if (value === undefined) return [];
  return v.list(value, "pending secrets", MAX_PENDING_SECRETS, (item) => {
    const entry = v.record(item, "pending secret");
    const purpose = v.record(entry.purpose, "purpose");
    return {
      id: v.text(entry.id, "secret id", 128),
      client: v.text(entry.client, "client", 128),
      ...(entry.task === undefined
        ? {}
        : { task: v.text(entry.task, "task", 128) }),
      purpose: { untrusted: v.text(purpose.untrusted, "purpose", 2048) },
      destination: parseDestination(entry.destination),
      fields: v.list(entry.fields, "fields", MAX_SECRET_FIELDS, parseField),
      admin: v.flag(entry.admin, "admin"),
      canSave: v.flag(entry.canSave, "canSave"),
      requestExpiresAt: v.finite(entry.requestExpiresAt, "expiry"),
    };
  });
}

function parseValuesMap(value: unknown): Record<string, string> {
  const raw = v.record(value, "values");
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_SECRET_FIELDS)
    v.fail("values must match the requested fields");
  const out: Record<string, string> = {};
  for (const key of keys) {
    const text = v.text(raw[key], `value ${key}`, MAX_SECRET_VALUE_CHARS);
    if (text.length === 0) v.fail(`value ${key} is required`);
    out[key] = text;
  }
  return out;
}

export function parseServerSecretIntents(value: unknown): ServerSecretIntent[] {
  if (value === undefined) return [];
  return v.list(value, "secret intents", v.MAX_RESULTS, (item) => {
    const intent = v.record(item, "secret intent");
    const action = intent.action;
    if (action !== "provide" && action !== "decline")
      v.fail("secret intent action is invalid");
    const base: ServerSecretIntent = {
      id: v.text(intent.id, "secret intent id", 64),
      secretId: v.text(intent.secretId, "secret id", 128),
      action,
      expiresAt: v.finite(intent.expiresAt, "expiry"),
    };
    if (action === "provide") {
      base.values = parseValuesMap(intent.values);
      const retention = intent.retention;
      if (retention !== "ephemeral" && retention !== "saved")
        v.fail("retention must be ephemeral or saved");
      base.retention = retention;
      if (intent.saveName !== undefined)
        base.saveName = v.text(intent.saveName, "save name", 128);
      if (intent.reuse !== undefined)
        base.reuse = v.flag(intent.reuse, "reuse");
    }
    return base;
  });
}

export function secretIntentView(intent: SecretIntentRecord): SecretIntentView {
  return {
    id: intent.id,
    action: intent.action,
    status: intent.status,
    ...(intent.reason === undefined ? {} : { reason: intent.reason }),
    expiresAt: intent.expiresAt,
  };
}

export function pendingSecretRows(state: ServerState, now: number) {
  return Object.entries(state.clients).flatMap(([id, client]) =>
    (client.pendingSecrets ?? [])
      .filter((item) => item.requestExpiresAt > now)
      .map((item) => {
        const latest = (client.secretIntents ?? [])
          .filter((intent) => intent.secretId === item.id)
          .at(-1);
        return {
          origin: id,
          originName: client.name,
          ...item,
          intent: latest ? secretIntentView(latest) : null,
        };
      }),
  );
}

function secretIntentsOf(client: LinkedClient): SecretIntentRecord[] {
  if (!client.secretIntents) client.secretIntents = [];
  return client.secretIntents;
}

export function applySecretSync(
  client: LinkedClient,
  pendingSecrets: PendingSecretSummary[],
  results: v.IntentResult[],
  now: number,
  vault: SecretIntentVault,
): ServerSecretIntent[] {
  vault.sweep(now);
  client.pendingSecrets = pendingSecrets;
  const intents = secretIntentsOf(client);
  const byId = new Map(intents.map((item) => [item.id, item]));
  for (const result of results) {
    const intent = byId.get(result.id);
    if (!intent || FINISHED.has(intent.status)) continue;
    intent.status = result.status;
    if (result.reason !== undefined) intent.reason = result.reason;
    vault.delete(intent.id);
  }
  for (const intent of intents) {
    if (!FINISHED.has(intent.status) && intent.expiresAt <= now) {
      intent.status = "refused";
      intent.reason = "expired";
      vault.delete(intent.id);
    }
  }
  const deliverable: ServerSecretIntent[] = [];
  for (const intent of intents) {
    if (FINISHED.has(intent.status)) continue;
    if (intent.action === "decline") {
      if (intent.status === "queued") intent.status = "delivered";
      deliverable.push({
        id: intent.id,
        secretId: intent.secretId,
        action: "decline",
        expiresAt: intent.expiresAt,
      });
      continue;
    }
    const payload = vault.get(intent.id, now);
    if (!payload) {
      intent.status = "refused";
      intent.reason = "secret values were cleared before delivery";
      continue;
    }
    if (intent.status === "queued") intent.status = "delivered";
    deliverable.push({
      id: intent.id,
      secretId: intent.secretId,
      action: "provide",
      expiresAt: intent.expiresAt,
      values: payload.values,
      retention: payload.retention,
      ...(payload.saveName === undefined ? {} : { saveName: payload.saveName }),
      ...(payload.reuse === undefined ? {} : { reuse: payload.reuse }),
    });
  }
  if (intents.length > MAX_SECRET_INTENTS)
    intents.splice(0, intents.length - MAX_SECRET_INTENTS);
  return deliverable;
}

export async function queueSecretProvide(
  file: ServerStateFile,
  vault: SecretIntentVault,
  now: number,
  input: Record<string, unknown>,
  stepUp: (password: unknown) => Promise<void>,
): Promise<SecretIntentRecord> {
  const clientId = v.text(input.client, "client", 64);
  const secretId = v.text(input.id, "secret id", 128);
  const retention = input.retention === "saved" ? "saved" : "ephemeral";
  const reuse = input.reuse === true;
  const saveName =
    retention === "saved"
      ? v.text(input.saveName, "save name", 128).trim()
      : undefined;
  if (retention === "saved" && !saveName)
    throw new HomectlError(2, "Enter a name to save this secret in the vault");

  const client = linked(await file.read(), clientId);
  if (!client) throw new HomectlError(3, "Unknown workspace client");
  if (client.remoteApproval !== true)
    throw new HomectlError(
      3,
      "This client does not accept approvals from this server",
    );
  const req = (client.pendingSecrets ?? []).find(
    (item) => item.id === secretId && item.requestExpiresAt > now,
  );
  if (!req)
    throw new HomectlError(
      3,
      "That secret request is not waiting on this client",
    );
  if (req.admin)
    throw new HomectlError(
      3,
      "This secret requires admin elevation; provide it on its own device",
    );
  if (retention === "saved" && !req.canSave)
    throw new HomectlError(2, "Saved retention needs the vault on that client");
  if (
    reuse &&
    (retention !== "saved" ||
      req.destination.kind === "vault-only" ||
      req.fields.some((field) => field.kind === "ssh-key"))
  )
    throw new HomectlError(
      3,
      "This secret cannot be saved for automatic reuse",
    );

  const values = parseValuesMap(input.values);
  const expected = new Set(req.fields.map((field) => field.name));
  if (
    Object.keys(values).length !== expected.size ||
    !Object.keys(values).every((key) => expected.has(key))
  )
    throw new HomectlError(2, "Secret values must match the requested fields");

  await stepUp(input.password);

  const intent: SecretIntentRecord = {
    id: randomUUID(),
    secretId,
    action: "provide",
    status: "queued",
    createdAt: now,
    expiresAt: Math.min(now + SECRET_INTENT_MS, req.requestExpiresAt),
  };
  await file.update((state) => {
    const current = linked(state, clientId);
    if (!current) throw new HomectlError(3, "Unknown workspace client");
    const intents = secretIntentsOf(current);
    if (
      intents.some(
        (item) => item.secretId === secretId && item.status !== "refused",
      )
    )
      throw new HomectlError(
        3,
        "This secret request already has a response on its way",
      );
    intents.push(intent);
  });
  vault.put(intent.id, intent.expiresAt, {
    values,
    retention,
    ...(saveName ? { saveName } : {}),
    ...(reuse ? { reuse } : {}),
  });
  return intent;
}

export async function queueSecretDecline(
  file: ServerStateFile,
  now: number,
  input: Record<string, unknown>,
): Promise<SecretIntentRecord> {
  const clientId = v.text(input.client, "client", 64);
  const secretId = v.text(input.id, "secret id", 128);
  const client = linked(await file.read(), clientId);
  if (!client) throw new HomectlError(3, "Unknown workspace client");
  if (client.remoteApproval !== true)
    throw new HomectlError(
      3,
      "This client does not accept approvals from this server",
    );
  const req = (client.pendingSecrets ?? []).find(
    (item) => item.id === secretId && item.requestExpiresAt > now,
  );
  if (!req)
    throw new HomectlError(
      3,
      "That secret request is not waiting on this client",
    );
  const intent: SecretIntentRecord = {
    id: randomUUID(),
    secretId,
    action: "decline",
    status: "queued",
    createdAt: now,
    expiresAt: Math.min(now + INTENT_MS, req.requestExpiresAt),
  };
  await file.update((state) => {
    const current = linked(state, clientId);
    if (!current) throw new HomectlError(3, "Unknown workspace client");
    const intents = secretIntentsOf(current);
    if (
      intents.some(
        (item) => item.secretId === secretId && item.status !== "refused",
      )
    )
      throw new HomectlError(
        3,
        "This secret request already has a response on its way",
      );
    intents.push(intent);
  });
  return intent;
}

export async function handleSecretOwnerRoute(
  path: string,
  input: Record<string, unknown>,
  stepUp: (password: unknown) => Promise<void>,
  deps: {
    file: ServerStateFile;
    vault: SecretIntentVault;
    load: () => Promise<ServerState>;
    now: () => number;
  },
): Promise<unknown> {
  switch (path) {
    case "/v1/owner/workspace/secrets/pending":
      return pendingSecretRows(await deps.load(), deps.now());
    case "/v1/owner/workspace/secrets/provide":
      await deps.load();
      return queueSecretProvide(
        deps.file,
        deps.vault,
        deps.now(),
        input,
        stepUp,
      );
    case "/v1/owner/workspace/secrets/decline":
      await deps.load();
      return queueSecretDecline(deps.file, deps.now(), input);
    default:
      return undefined;
  }
}
