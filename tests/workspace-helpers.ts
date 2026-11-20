// In-process fixtures for the workspace tests: one server, one client, and a
// transport that routes straight to the server's network paths.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotInput } from "../src/backup";
import type { BrokerOperation, DecideInput } from "../src/broker/types";
import type { EventEnvelope } from "../src/core/contracts";
import { HomectlError } from "../src/types";
import type { Post } from "../src/workspace/channel";
import { WorkspaceClient } from "../src/workspace/client";
import { WorkspaceServer } from "../src/workspace/server";
import {
  type ClientLink,
  clientLinkFile,
  type ServerState,
  serverStateFile,
} from "../src/workspace/state";

export const OWNER_PASSWORD = "owner-pass";
export const SERVER_ADDRESS = "http://server.test:7451";

// Owner step-up as the daemon supplies it: wrong password refuses.
export async function stepUp(password: unknown): Promise<void> {
  if (password !== OWNER_PASSWORD)
    throw new HomectlError(3, "Confirm with the owner password");
}

export interface Harness {
  dir: string;
  serverDir: string;
  clientDir: string;
  server: WorkspaceServer;
  client: WorkspaceClient;
  // Every request from the client goes through here; tests may replace it.
  post: Post;
  events: EventEnvelope[];
  gapFrom: number | undefined;
  ops: BrokerOperation[];
  decisions: DecideInput[];
  files: SnapshotInput[];
  // Client-side clock override for expiry checks.
  clientClock: { now: number } | undefined;
  serverState(): Promise<ServerState>;
  clientLink(): Promise<ClientLink>;
  cleanup(): Promise<void>;
}

export async function fixture(
  options: { serverNow?: () => number; clientNow?: () => number } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "hc-workspace-"));
  const serverDir = join(dir, "server");
  const clientDir = join(dir, "client");
  await mkdir(serverDir, { recursive: true });
  await mkdir(clientDir, { recursive: true });
  const server = new WorkspaceServer(serverDir, {
    now: options.serverNow ?? Date.now,
  });
  const harness: Harness = {
    dir,
    serverDir,
    clientDir,
    server,
    client: undefined as unknown as WorkspaceClient,
    post: (path, value) => server.network(path, value),
    events: [],
    gapFrom: undefined,
    ops: [],
    decisions: [],
    files: [],
    clientClock: undefined,
    serverState: () => serverStateFile(serverDir).read(),
    clientLink: () => clientLinkFile(clientDir).read(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  harness.client = new WorkspaceClient(clientDir, {
    pending: async () => harness.ops,
    decide: async (input) => {
      harness.decisions.push(input);
      return { applied: true };
    },
    events: {
      since: async (after) => {
        if (harness.gapFrom !== undefined)
          return { gap: true, firstRetainedSeq: harness.gapFrom };
        return harness.events.filter((event) => event.seq > after);
      },
    },
    backupFiles: async () => harness.files,
    post: () => (path, value) => harness.post(path, value),
    now: options.clientNow ?? Date.now,
  });
  return harness;
}

// Opens an invite on the server and joins the client to it.
export async function link(
  h: Harness,
  remoteApproval = true,
): Promise<{ code: string }> {
  const invite = (await h.server.owner(
    "/v1/owner/workspace/invite",
    { password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };
  await h.client.owner(
    "/v1/owner/workspace/join",
    {
      address: SERVER_ADDRESS,
      code: invite.code,
      remoteApproval,
      password: OWNER_PASSWORD,
    },
    stepUp,
  );
  return invite;
}

export async function clientId(h: Harness): Promise<string> {
  return (await h.clientLink()).id;
}

export async function serverId(h: Harness): Promise<string> {
  return (await h.serverState()).id;
}

export function event(seq: number): EventEnvelope {
  return {
    id: `device:${seq}`,
    origin: "device",
    seq,
    at: seq,
    type: "operation.updated",
    subject: `op-${seq}`,
    audience: [],
    data: { seq },
  };
}

export function op(
  overrides: Partial<{
    id: string;
    fingerprint: string;
    stepUp: boolean;
    expiresAt: number;
    narrative: string;
  }> = {},
): BrokerOperation {
  return {
    id: overrides.id ?? "op-1",
    client: "laptop-a",
    host: "lab",
    argv: ["systemctl", "status", "nginx"],
    impact: "Read service status",
    classification: { kind: "read" },
    sudo: false,
    risk: "low",
    machineHash: "machine",
    fingerprint: overrides.fingerprint ?? "fp-1",
    decision: {
      verdict: "ask",
      source: "policy",
      reason: "needs owner approval",
      stepUp: overrides.stepUp ?? false,
      humanOnly: false,
      policyRevision: 1,
    },
    state: "awaiting-approval",
    createdAt: 0,
    expiresAt: overrides.expiresAt ?? Date.now() + 600_000,
    updatedAt: 0,
    ...(overrides.narrative ? { narrative: overrides.narrative } : {}),
  } as unknown as BrokerOperation;
}
