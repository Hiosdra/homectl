// Ordered migration steps. Each step runs at most once per migration (progress
// is recorded) and must be safe to run again after a crash mid-step.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import type { MigrationContext, MigrationStep } from "./index";

const RETIRED_REASON = "retired-by-migration";

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

function statePath(context: MigrationContext) {
  return join(context.workspace, "control-plane", "state.json");
}

async function loadState(
  context: MigrationContext,
): Promise<LegacyState | undefined> {
  let text: string;
  try {
    text = await readFile(statePath(context), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = JSON.parse(text) as LegacyState;
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
    "Close pending and approved operations from 0.2 (re-plan them under the new approval flow); keep their history",
  async run(context) {
    const state = await loadState(context);
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
    const temp = `${statePath(context)}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, statePath(context));
    context.note(
      `${closed} open operation(s) from 0.2 were closed; ask the agent to plan them again`,
    );
  },
  async verify(context) {
    const state = await loadState(context);
    if (!state) return;
    for (const op of Object.values(state.operations))
      if (["pending", "approved", "executing"].includes(op.state))
        throw new HomectlError(
          5,
          "An open 0.2 operation remains after migration",
        );
  },
};

export const STEPS: readonly MigrationStep[] = [retirePendingAuthority];
