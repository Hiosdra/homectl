// One operation waiting for the owner. The title says what will run and where, the
// exact command follows it, and the reason it waits is said in plain words. The
// broker's own reason, the risk code and the other technical values sit under
// Details. The assistant's own story is shown as untrusted text. The decision block
// asks for the owner password first, then offers the primary and secondary actions;
// remembering a rule and asking for a revision sit under "More options".
import { useState } from "react";
import {
  describeError,
  type Decision,
  type DecideResult,
  type PendingOperation,
  ownerCall,
  untrustedText,
} from "./api";
import { Icon } from "./icons";
import { useAssistantNames } from "./assistant-names";
import { riskView } from "./risk";
import {
  approveRememberOffered,
  isUnderReview,
  UNDER_REVIEW_NOTE,
} from "./review";
import { expiresIn, relativeTime, toEpoch } from "./time";
import {
  Argv,
  Badge,
  Dialog,
  fmtTime,
  MachineChip,
  MachineText,
  Notice,
  PasswordStep,
  Untrusted,
} from "./ui";
import {
  displayName,
  plainAction,
  riskLine,
  sentenceCase,
  whyWaits,
} from "./plain-words";
import {
  isProxmoxOperation,
  OwnerOnlyNote,
  ProxmoxDetailRows,
  proxmoxTitle,
} from "./proxmox";
import {
  FingerprintConfirm,
  fingerprintConfirmed,
  isSetupOperation,
  SetupDetailRows,
  SetupRequestBody,
  setupTitle,
} from "./setup-request";

export type ApprovalDecision =
  | "approve-once"
  | "approve-remember"
  | "deny-once"
  | "deny-remember"
  | "revise";

export const OUTCOME: Record<string, string> = {
  succeeded: "Approved. The command ran and finished successfully.",
  failed:
    "Approved, but the command failed. Its result is in the assistant's history.",
  dispatching: "Approved. The command is starting.",
  denied: "Denied. The assistant was told.",
  cancelled: "Sent back for revision. The assistant must submit a new plan.",
};

// Used when the broker's answer is still in flight (for example, an approved
// command is dispatching). The decision itself is already recorded.
export const DECISION_NOTICE: Record<ApprovalDecision, string> = {
  "approve-once": "Approved. The command is starting.",
  "approve-remember": "Approved, and the rule is saved.",
  "deny-once": "Denied. The assistant was told.",
  "deny-remember": "Denied, and the rule is saved.",
  revise: "Sent back for revision. The assistant must submit a new plan.",
};

// The plain words for "More options", each saying what it does to later requests.
const MORE_OPTIONS = {
  rememberApprove:
    "Approve now, and future commands exactly like this run without asking.",
  rememberDeny:
    "Refuse now, and future commands exactly like this are refused.",
  revise: "Send it back. The assistant must submit a new plan first.",
};

export function ApprovalScreen({
  operation,
  onDone,
  onError,
  onBack,
}: {
  operation: PendingOperation;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
  onBack?: () => void;
}) {
  const [password, setPassword] = useState("");
  // Enrolment only: the fingerprint typed from the card. Cleared once sent.
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const names = useAssistantNames();
  const [confirming, setConfirming] = useState<ApprovalDecision | undefined>();
  const decision: Decision = operation.decision;
  const needsStepUp = decision.stepUp === true;
  const setup = isSetupOperation(operation);
  // Adding a machine: the approve button waits for the typed fingerprint.
  const enrolling = operation.setup?.kind === "enroll";
  const confirmOk = !enrolling || fingerprintConfirmed(operation, confirmText);
  const approving = (kind: ApprovalDecision) => kind.startsWith("approve");
  const risk = riskView(operation.risk);
  const expires = toEpoch(operation.expiresAt);
  const asked = toEpoch(operation.createdAt);
  const underReview = isUnderReview(decision.source);

  const send = async (kind: ApprovalDecision) => {
    if (busy) return;
    // Take the password out of the form before the request leaves.
    const typed = password;
    const typedKey = confirmText;
    setPassword("");
    setConfirmText("");
    setConfirming(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<DecideResult>("/v1/owner/decide", {
        operationId: operation.id,
        fingerprint: operation.fingerprint,
        decision: kind,
        ...(approving(kind) && needsStepUp ? { password: typed } : {}),
        ...(approving(kind) && enrolling
          ? { confirmFingerprint: typedKey.trim() }
          : {}),
      });
      onDone(
        setup && result.operation.state === "succeeded"
          ? "Approved. The change is done."
          : setup && result.operation.state === "failed"
            ? "Approved, but the change did not finish. The assistant can see why."
            : (OUTCOME[result.operation.state] ?? DECISION_NOTICE[kind]),
      );
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const missingPassword = needsStepUp && password.length === 0;
  const approveBlocked = busy || missingPassword || !confirmOk;
  const who = displayName(operation.client, names);
  // Proxmox and setup requests are titled by what they do; neither is remembered as a rule.
  const proxmox = isProxmoxOperation(operation);
  const title = setup
    ? setupTitle(operation)
    : proxmox
      ? proxmoxTitle(operation)
      : `${sentenceCase(plainAction(operation.argv))} on ${operation.host}?`;
  const meta = [
    asked !== undefined ? `Asked ${relativeTime(asked)}` : undefined,
    expires !== undefined ? expiresIn(expires) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

  return (
    <article className="stack" aria-labelledby="approval-title">
      {onBack ? (
        <div>
          <button type="button" className="quiet" onClick={onBack}>
            <Icon name="back" />
            Back to Needs you
          </button>
        </div>
      ) : null}
      <section data-risk={risk.stripe}>
        <div className="row between">
          <Badge tone={risk.tone} icon={risk.icon}>
            {risk.label}
          </Badge>
          {meta ? <span className="request-meta">{meta}</span> : null}
        </div>
        <h2 id="approval-title" className="approval-title">
          <MachineText text={title} machines={[operation.host]} />
        </h2>
        <p className="lead">
          From <strong>{who}</strong>
          {operation.task ? `, task ${operation.task}` : ""}.
        </p>
        <OwnerOnlyNote operation={operation} />
        {setup ? (
          <>
            <h3 className="sub-title">What it changes</h3>
            <SetupRequestBody operation={operation} />
          </>
        ) : (
          <>
            <h3 className="sub-title">
              {proxmox ? "The exact request" : "The exact command"}
            </h3>
            <div
              className="command-block"
              role="group"
              aria-label="Exact command"
            >
              <Argv argv={operation.argv} />
            </div>
          </>
        )}
        <p className="small">
          {riskLine(risk.stripe, false)}
          {operation.sudo ? " It runs with admin rights (sudo)." : ""}
        </p>
        <p className="small">
          <strong>Why it waits.</strong>{" "}
          {whyWaits({
            stripe: risk.stripe,
            stepUp: needsStepUp,
            humanOnly: decision.humanOnly,
            underReview,
          })}
        </p>
        <details className="details">
          <summary>Details</summary>
          <dl>
            <dt>Machine</dt>
            <dd>
              <MachineChip name={operation.host} />
            </dd>
            <dt>Risk level</dt>
            <dd>
              <span className="mono">{operation.risk}</span> · {risk.label}
            </dd>
            <dt>Classification</dt>
            <dd>
              {operation.classification}
              {operation.sudo ? " · runs with sudo" : ""}
            </dd>
            <ProxmoxDetailRows operation={operation} />
            <SetupDetailRows operation={operation} />
            <dt>Requested by</dt>
            <dd>
              <span className="mono">{operation.client}</span>
              {operation.task ? ` · task ${operation.task}` : ""}
            </dd>
            <dt>Broker reason</dt>
            <dd>
              {decision.verdict} ({decision.source}): {decision.reason}
            </dd>
            <dt>Asked at</dt>
            <dd title={fmtTime(operation.createdAt)}>
              {fmtTime(operation.createdAt)}
            </dd>
            <dt>Expires</dt>
            <dd title={fmtTime(operation.expiresAt)}>
              {expires !== undefined
                ? expiresIn(expires)
                : fmtTime(operation.expiresAt)}
            </dd>
          </dl>
        </details>
      </section>

      <section className="stack">
        <h3>What the assistant says</h3>
        <Untrusted
          label="Written by the assistant"
          text={untrustedText(operation.narrative)}
        />
        {!operation.narrative ? (
          <p className="small muted">The assistant gave no explanation.</p>
        ) : null}
      </section>

      <section className="decision stack" aria-labelledby="decision-title">
        <h3 id="decision-title">Your decision</h3>
        {underReview ? <Notice tone="warn">{UNDER_REVIEW_NOTE}</Notice> : null}
        {enrolling ? (
          <FingerprintConfirm
            operation={operation}
            value={confirmText}
            onChange={setConfirmText}
          />
        ) : null}
        {needsStepUp ? (
          <>
            <Notice tone="warn">
              Approving this needs your owner password.
            </Notice>
            <PasswordStep
              value={password}
              onChange={setPassword}
              hint="required to approve"
            />
          </>
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="decision-actions">
          <div className="request-actions">
            <button
              type="button"
              className="primary"
              disabled={approveBlocked}
              onClick={() => send("approve-once")}
            >
              Approve once
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => send("deny-once")}
            >
              Deny
            </button>
          </div>
          {missingPassword && !busy ? (
            <p className="small muted" role="note">
              Enter your owner password to approve.
            </p>
          ) : null}
        </div>
        <p className="small muted">
          {setup
            ? "Approving allows this request once. It does not create a rule."
            : "Approving allows this exact command once. It does not create a rule."}
        </p>
        <details className="more-options">
          <summary>More options</summary>
          <div className="stack">
            {!proxmox && !setup && approveRememberOffered(decision) ? (
              <div className="option-row">
                <button
                  type="button"
                  disabled={approveBlocked}
                  onClick={() => setConfirming("approve-remember")}
                >
                  Approve and remember…
                </button>
                <p className="small muted">{MORE_OPTIONS.rememberApprove}</p>
              </div>
            ) : null}
            {proxmox || setup ? null : (
              <div className="option-row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => setConfirming("deny-remember")}
                >
                  Deny and remember…
                </button>
                <p className="small muted">{MORE_OPTIONS.rememberDeny}</p>
              </div>
            )}
            <div className="option-row">
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => send("revise")}
              >
                Ask to revise
              </button>
              <p className="small muted">{MORE_OPTIONS.revise}</p>
            </div>
          </div>
        </details>
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
            <MachineText
              text={
                confirming === "approve-remember"
                  ? `Future commands exactly like "${operation.argv.join(" ")}" on ${operation.host} from ${who} will run without asking. You can remove the rule in Permissions.`
                  : `Future commands exactly like "${operation.argv.join(" ")}" on ${operation.host} from ${who} will be refused. You can remove the rule in Permissions.`
              }
              machines={[operation.host]}
            />
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
