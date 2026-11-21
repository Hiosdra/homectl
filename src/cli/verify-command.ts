// `home-ctl verify <operation> passed|failed|inconclusive --summary TEXT`: the
// agent's own check of a finished operation (homelab #21 §7). It is recorded
// once, by the client that ran the operation, and never changes the state or
// the exit status. Kept apart from broker-commands.ts to leave it room.
import { callBroker } from "../broker/client";
import type { Endpoint } from "../broker/paths";
import {
  VERIFICATION_STATUSES,
  type VerificationStatus,
} from "../core/verification";
import { HomectlError } from "../types";

export const VERIFY_USAGE =
  "Usage: home-ctl verify <operation> passed|failed|inconclusive --summary TEXT";

interface VerifiedView {
  id: string;
  state: string;
}

interface VerifyContext {
  summary: string | undefined;
  auth: () => Promise<{ endpoint: Endpoint; authorization: string }>;
  emit: (value: unknown, human?: string) => void;
}

// Checks the arguments before any broker call. The broker checks them again.
export function parseVerify(
  positionals: string[],
  summary: string | undefined,
): { id: string; status: VerificationStatus; summary: string } {
  const [id, status, ...extra] = positionals;
  if (!id || !status || extra.length) throw new HomectlError(2, VERIFY_USAGE);
  if (!VERIFICATION_STATUSES.includes(status as VerificationStatus))
    throw new HomectlError(
      2,
      "verify takes passed, failed or inconclusive as its verdict",
    );
  if (summary === undefined || summary.trim() === "")
    throw new HomectlError(
      2,
      `${VERIFY_USAGE}. The summary says what you checked and what you saw.`,
    );
  return { id, status: status as VerificationStatus, summary };
}

export async function verifyCommand(
  positionals: string[],
  ctx: VerifyContext,
): Promise<number> {
  const { id, status, summary } = parseVerify(positionals, ctx.summary);
  const view = await callBroker<VerifiedView>(
    "/v1/verify",
    { id, verification: { status, summary } },
    await ctx.auth(),
  );
  ctx.emit(
    view,
    `Recorded your check of ${id} as ${status}. The state (${view.state}) and the exit status are unchanged: this is your report, not homectl's.`,
  );
  return 0;
}

// The agent's report, appended to human output of op and wait. It is labelled
// so it is never read as the exit status.
export function verificationNote(view: {
  verification?: { status: string; summary: string };
}): string | undefined {
  return view.verification
    ? `Agent check (not the exit status): ${view.verification.status} - ${view.verification.summary}`
    : undefined;
}
