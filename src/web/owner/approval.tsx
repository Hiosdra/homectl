// One operation waiting for the owner. The screen shows what will run (exact
// host and argv), the broker's policy reason, and the agent's own story as
// untrusted text. The fingerprint goes back exactly as the broker sent it.
import { useState } from "react";
import {
  describeError,
  type Decision,
  type DecideResult,
  type PendingOperation,
  ownerCall,
  untrustedText,
} from "./api";
import {
  approveRememberOffered,
  isUnderReview,
  UNDER_REVIEW_NOTE,
} from "./review";
import {
  Argv,
  Badge,
  Dialog,
  fmtTime,
  Notice,
  PasswordStep,
  Untrusted,
} from "./ui";

export type ApprovalDecision =
  | "approve-once"
  | "approve-remember"
  | "deny-once"
  | "deny-remember"
  | "revise";

const OUTCOME: Record<string, string> = {
  succeeded: "Approved. The command ran and finished successfully.",
  failed:
    "Approved, but the command failed. Its result is in the agent's history.",
  dispatching: "Approved. The command is starting.",
  denied: "Denied. The agent was told.",
  cancelled: "Sent back for revision. The agent must submit a new plan.",
};

// Used when the broker's answer is still in flight (for example, an approved
// command is dispatching). The decision itself is already recorded.
const DECISION_NOTICE: Record<ApprovalDecision, string> = {
  "approve-once": "Approved. The command is starting.",
  "approve-remember": "Approved, and the rule is saved.",
  "deny-once": "Denied. The agent was told.",
  "deny-remember": "Denied, and the rule is saved.",
  revise: "Sent back for revision. The agent must submit a new plan.",
};

export function ApprovalScreen({
  operation,
  onDone,
  onError,
}: {
  operation: PendingOperation;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<ApprovalDecision | undefined>();
  const decision: Decision = operation.decision;
  const needsStepUp = decision.stepUp === true;
  const approving = (kind: ApprovalDecision) => kind.startsWith("approve");

  const send = async (kind: ApprovalDecision) => {
    if (busy) return;
    // Take the password out of the form before the request leaves.
    const typed = password;
    setPassword("");
    setConfirming(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<DecideResult>("/v1/owner/decide", {
        operationId: operation.id,
        fingerprint: operation.fingerprint,
        decision: kind,
        ...(approving(kind) && needsStepUp ? { password: typed } : {}),
      });
      onDone(OUTCOME[result.operation.state] ?? DECISION_NOTICE[kind]);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const approveBlocked = busy || (needsStepUp && password.length === 0);

  return (
    <article className="stack" aria-labelledby="approval-title">
      <section>
        <div className="row between">
          <h2 id="approval-title">Approve this command?</h2>
          <Badge
            tone={
              operation.risk === "R3" || operation.risk === "R4"
                ? "bad"
                : "warn"
            }
          >
            Risk {operation.risk}
          </Badge>
        </div>
        <dl>
          <dt>Host</dt>
          <dd className="mono">{operation.host}</dd>
          <dt>Command</dt>
          <dd>
            <Argv argv={operation.argv} />
          </dd>
          <dt>Classification</dt>
          <dd>
            {operation.classification}
            {operation.sudo ? " · runs with sudo" : ""}
          </dd>
          <dt>Requested by</dt>
          <dd>
            {operation.client}
            {operation.task ? ` · task ${operation.task}` : ""}
          </dd>
          <dt>Policy says</dt>
          <dd>
            {decision.verdict} ({decision.source}): {decision.reason}
          </dd>
          <dt>Expires</dt>
          <dd>{fmtTime(operation.expiresAt)}</dd>
        </dl>
      </section>

      <section className="stack">
        <h3>What the agent says</h3>
        <Untrusted text={untrustedText(operation.narrative)} />
        {!operation.narrative ? (
          <p className="small muted">The agent gave no explanation.</p>
        ) : null}
      </section>

      <section className="stack" aria-label="Decide">
        <p className="small muted">
          Approving allows this exact command once. It does not create a
          reusable permission unless you choose "remember".
        </p>
        {isUnderReview(decision.source) ? (
          <Notice tone="warn">{UNDER_REVIEW_NOTE}</Notice>
        ) : null}
        {needsStepUp ? (
          <Notice tone="warn">
            This needs you to confirm with your owner password.
          </Notice>
        ) : null}
        {needsStepUp ? (
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to approve"
          />
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={approveBlocked}
            onClick={() => send("approve-once")}
          >
            Approve once
          </button>
          {approveRememberOffered(decision) ? (
            <button
              type="button"
              disabled={approveBlocked}
              onClick={() => setConfirming("approve-remember")}
            >
              Approve and remember…
            </button>
          ) : null}
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => send("deny-once")}
          >
            Deny
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setConfirming("deny-remember")}
          >
            Deny and remember…
          </button>
          <button type="button" disabled={busy} onClick={() => send("revise")}>
            Ask to revise
          </button>
        </div>
        {decision.humanOnly ? (
          <p className="small muted">
            This kind of action can only be approved once. It cannot become a
            rule.
          </p>
        ) : null}
      </section>

      {confirming ? (
        <Dialog
          title={
            confirming === "approve-remember"
              ? "Approve and remember?"
              : "Deny and remember?"
          }
          onClose={() => setConfirming(undefined)}
        >
          <p>
            {confirming === "approve-remember"
              ? `Future commands exactly like "${operation.argv.join(" ")}" on ${operation.host} from ${operation.client} will run without asking. You can remove the rule in Permissions.`
              : `Future commands exactly like "${operation.argv.join(" ")}" on ${operation.host} from ${operation.client} will be refused. You can remove the rule in Permissions.`}
          </p>
          <div className="row">
            <button
              type="button"
              className={
                confirming === "approve-remember" ? "primary" : "danger"
              }
              disabled={approveBlocked && confirming === "approve-remember"}
              onClick={() => send(confirming)}
            >
              {confirming === "approve-remember"
                ? "Approve and remember"
                : "Deny and remember"}
            </button>
            <button type="button" onClick={() => setConfirming(undefined)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </article>
  );
}
