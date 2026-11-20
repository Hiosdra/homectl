// Steps for 0.2 control-plane state: open operations are closed (their
// approvals are never honoured again) and 0.2 signing or session authority is
// reported as retired. Nothing here copies a key or a session.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HomectlError } from "../types";
import { digestOf, pathExists, writeFileAtomic } from "./files";
import type { MigrationContext, MigrationStep } from "./types";

export const RETIRED_REASON = "retired-by-migration";

interface LegacyOperation {
  state: string;
  reason?: string;
  finishedAt?: number;
  updatedAt?: number;
  spawnAttempted?: boolean;
  approval?: unknown;
}
interface LegacyState {
  version: number;
  operations: Record<string, LegacyOperation>;
}

export function legacyStatePath(workspace: string): string {
  return join(workspace, "control-plane", "state.json");
}

export function legacySessionPath(inventoryPath: string): string {
  return `${inventoryPath}.session`;
}

async function loadState(workspace: string): Promise<LegacyState | undefined> {
  let text: string;
  try {
    text = await readFile(legacyStatePath(workspace), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let state: LegacyState;
  try {
    state = JSON.parse(text) as LegacyState;
  } catch {
    throw new HomectlError(5, "control-plane/state.json is not valid JSON");
  }
  if (!state || typeof state.operations !== "object")
    throw new HomectlError(5, "control-plane/state.json is not recognized");
  return state;
}

// Pending and approved operations carry approval authority that 0.3.0 no
// longer honours (approvals become owner-signed and single-use). They are
// closed, not deleted, so history is kept. An operation left `executing`
// becomes `unknown`: whether it ran cannot be known from here.
export const retirePendingAuthority: MigrationStep = {
  id: "v2-retire-pending-authority",
  from: 2,
  to: 3,
  description:
    "Close pending and approved operations from 0.2 (re-plan them under the owner approval flow); keep their history",
  touches: (context) => [legacyStatePath(context.workspace)],
  async run(context) {
    const state = await loadState(context.workspace);
    if (!state) return;
    let closed = 0;
    for (const op of Object.values(state.operations)) {
      if (op.state === "pending" || op.state === "approved") {
        op.state = "failed";
      } else if (op.state === "executing") {
        op.state = "unknown";
        op.spawnAttempted = true;
      } else continue;
      op.reason = RETIRED_REASON;
      op.finishedAt = context.now;
      op.updatedAt = context.now;
      closed++;
    }
    if (!closed) return;
    await writeFileAtomic(
      legacyStatePath(context.workspace),
      JSON.stringify(state),
    );
    context.note(
      `${closed} open operation(s) from 0.2 were closed; ask the agent to plan them again`,
    );
  },
  async verify(context) {
    const state = await loadState(context.workspace);
    if (!state) return;
    for (const op of Object.values(state.operations))
      if (["pending", "approved", "executing"].includes(op.state))
        throw new HomectlError(
          5,
          "An open 0.2 operation remains after migration",
        );
  },
};

// 0.2 signing and session authority is never carried over. This step writes
// nothing; it tells the owner what was retired and refuses a broker key that
// is a copy of the 0.2 device key.
export const retireSigningAuthority: MigrationStep = {
  id: "v2-retire-signing-and-sessions",
  from: 2,
  to: 3,
  description:
    "Do not reuse the 0.2 device signing key, replicated approval authority or session agent; report them as retired",
  touches: () => [],
  async run(context) {
    const workspace = context.workspace;
    if (await pathExists(join(workspace, "control-plane", "device-key.json")))
      context.note(
        "The 0.2 device signing key was not carried over; 0.3 creates its own device key on first start",
      );
    if (await pathExists(join(workspace, "control-plane", "replica.json")))
      context.note(
        "0.2 replicated approval authority (control-plane/replica.json) is retired and kept as read-only evidence",
      );
    if (await pathExists(legacySessionPath(context.inventoryPath)))
      context.note(
        "0.2 session state was not restored. If the old session agent is still unlocked, lock it with `home-ctl session lock`; 0.3 unlocks with the owner's master password",
      );
  },
  async verify(context) {
    await assertNoCopiedSigningKey(context);
  },
};

export async function assertNoCopiedSigningKey(
  context: MigrationContext,
): Promise<void> {
  const legacy = await digestOf(
    join(context.workspace, "control-plane", "device-key.json"),
  );
  const current = await digestOf(
    join(context.brokerState, "keys", "device-key.json"),
  );
  if (legacy !== undefined && legacy === current)
    throw new HomectlError(
      5,
      "The 0.2 device signing key was copied into the 0.3 broker; that authority is not carried over",
    );
}
