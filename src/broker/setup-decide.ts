// Owner-side checks for setup requests, called from the engine's decide. Adding a
// machine needs the fingerprint the owner typed from the card. It must be one the
// machine presented when the request was made. The agent cannot reach this path:
// decide is an owner route, and an agent token is refused there.
import { HomectlError } from "../types";
import { parseApiKey } from "./ai-helper-routes";
import type { BrokerOperation, DecideInput } from "./types";

const APPROVALS = new Set(["approve-once", "approve-remember"]);

// Returns the confirmed fingerprint for an approved enrolment, undefined for any
// other decision. Throws when an enrolment is approved without a matching one.
export function enrolmentConfirmation(
  op: BrokerOperation,
  input: DecideInput,
): string | undefined {
  if (op.setup?.kind !== "enroll" || !APPROVALS.has(input.decision))
    return undefined;
  const typed = input.confirmFingerprint?.trim();
  if (!typed)
    throw new HomectlError(
      3,
      "Type the fingerprint the card shows to confirm adding this machine",
    );
  const presented = op.setup.presented ?? [];
  if (!presented.some((key) => key.fingerprint === typed))
    throw new HomectlError(
      3,
      "The typed fingerprint does not match the one the machine presented; nothing was approved",
    );
  return typed;
}

export function reviewerKeyForApproval(
  op: BrokerOperation,
  input: DecideInput,
): string | undefined {
  if (op.setup?.kind !== "ai-helper") return undefined;
  if (input.reviewerApiKey === undefined)
    throw new HomectlError(
      3,
      "Review this request in the owner panel on the originating device",
    );
  const key = parseApiKey(input.reviewerApiKey);
  if (key === undefined && op.setup.input.keyRequired)
    throw new HomectlError(2, "Enter the API key for this provider");
  return key;
}
