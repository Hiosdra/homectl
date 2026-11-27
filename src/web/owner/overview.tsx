// "Needs you": everything that waits for the owner, most urgent first, in one list
// with a heading per kind. Each card says what the assistant wants in one plain
// sentence; the exact command sits beside it. Small, undoable requests can be
// approved from the list in one tap; anything that needs the owner password (and
// every big or destructive change) opens its detail screen first. Requester text is
// never shown here; the detail screens show it, labelled as untrusted.
import { useEffect, useState } from "react";
import {
  describeError,
  type DecideResult,
  type PendingOperation,
  type PendingSecret,
  ownerCall,
} from "./api";
import { type ViewScope } from "./context";
import { ContextNote } from "./context-switcher";
import {
  DECISION_NOTICE,
  getRecentStepUpUntil,
  OUTCOME,
  setRecentStepUpUntil,
  type ApprovalDecision,
} from "./approval";
import { Icon } from "./icons";
import { actionView, canApproveFromList } from "./risk";
import { isUnderReview } from "./review";
import { relativeTime, toEpoch, waitingUntil } from "./time";
import { InlineApprovalPassword } from "./inline-password";
import { Argv, Badge, MachineText, Notice } from "./ui";
import { displayName, plainAction, riskLine } from "./plain-words";
import { proxmoxTitle } from "./proxmox";
import { setupTitle } from "./setup-request";
import { useAssistantRoster, type AssistantNames } from "./assistant-names";
import { setupHash } from "./route";
import { type SetupStatus } from "./setup-api";
import { SetupChecklist, UpgradeNotice } from "./setup-checklist";
import { wizardStep } from "./setup-copy";
import { describeDestination, SecretCard } from "./overview-secret-card";
export { describeDestination };

export function OverviewScreen({
  data,
  workspaceWaiting = 0,
  scope,
  setup,
  onSetupChanged,
  onOpen,
  onQuickDone,
  onError,
}: {
  data: {
    operations: PendingOperation[];
    secrets: PendingSecret[];
    loadedAt: number;
  };
  // Approvals waiting on linked clients (workspace server only).
  workspaceWaiting?: number;
  // The device context this inbox shows; the note names it.
  scope?: ViewScope;
  // The guided setup's progress: the checklist sits at the top while it is open.
  setup?: SetupStatus;
  onSetupChanged?: (next: SetupStatus) => void;
  onOpen: (hash: string) => void;
  // A one-tap decision: the message names the result, the list refreshes.
  onQuickDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  // Re-render every half minute so "in 12 minutes" stays true while open.
  const [, setNow] = useState(0);
  const roster = useAssistantRoster();
  const names = roster.names;
  useEffect(() => {
    const timer = setInterval(() => setNow((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const total = data.operations.length + data.secrets.length + workspaceWaiting;
  return (
    <>
      <div className="page-head">
        <h2>Needs you</h2>
        <p>
          {total === 0
            ? "Nothing is waiting. Assistants keep working within their permissions."
            : `${total} ${total === 1 ? "thing needs" : "things need"} you. Small changes can be approved here; anything bigger opens with its exact command shown.`}
        </p>
        {total > 0 ? (
          <div className="summary-pills">
            {data.operations.length > 0 ? (
              <Badge tone="warn" icon="shield">
                {data.operations.length}{" "}
                {data.operations.length === 1 ? "approval" : "approvals"}
              </Badge>
            ) : null}
            {data.secrets.length > 0 ? (
              <Badge tone="info" icon="key">
                {data.secrets.length}{" "}
                {data.secrets.length === 1
                  ? "secret request"
                  : "secret requests"}
              </Badge>
            ) : null}
            {workspaceWaiting > 0 ? (
              <Badge tone="neutral" icon="devices">
                {workspaceWaiting} on linked devices
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
      <ContextNote scope={scope} />
      {setup && onSetupChanged ? (
        <UpgradeNotice
          status={setup}
          onChanged={onSetupChanged}
          onError={onError}
        />
      ) : null}
      {total === 0 && setup && onSetupChanged ? (
        <SetupChecklist
          status={setup}
          onOpen={onOpen}
          onChanged={onSetupChanged}
          onError={onError}
        />
      ) : null}

      {total === 0 && roster.count === 0 ? (
        // A new install: nothing is set up yet, so "caught up" would mislead. The
        // checklist above names the next step.
        <section className="empty" aria-label="Nothing needs you yet">
          <div className="empty-mark">
            <Icon name="bot" />
          </div>
          <h3>Nothing needs you yet.</h3>
          {setup?.next ? (
            <p>
              Next:{" "}
              <a className="setup-link" href={setupHash(setup.next)}>
                {wizardStep(setup.next)?.title ?? "finish setup"} →
              </a>
            </p>
          ) : (
            <p>Set up homectl first: the checklist above shows each step.</p>
          )}
          {setup?.next ? null : (
            <div className="row">
              <button type="button" onClick={() => onOpen("#/agents")}>
                <Icon name="bot" />
                Connect an assistant
              </button>
            </div>
          )}
        </section>
      ) : total === 0 ? (
        <section className="empty" aria-label="All caught up">
          <div className="empty-mark">
            <Icon name="check-circle" />
          </div>
          <h3>You are all caught up</h3>
          <p>
            No approvals or secret requests are waiting. Assistants keep working
            within their permissions. This page updates live.
          </p>
          <div className="row">
            <button type="button" onClick={() => onOpen("#/agents")}>
              <Icon name="bot" />
              See your assistants
            </button>
          </div>
        </section>
      ) : null}

      {workspaceWaiting > 0 ? (
        <div className="group" aria-labelledby="workspace-waiting-heading">
          <h3 id="workspace-waiting-heading" className="group-title">
            Linked devices <Badge tone="count">{workspaceWaiting}</Badge>
          </h3>
          <div className="request-card">
            <p>
              {workspaceWaiting === 1
                ? "One approval is"
                : `${workspaceWaiting} approvals are`}{" "}
              waiting on a linked client. Each one is decided on that device.
            </p>
            <div className="request-actions">
              <button
                type="button"
                className="primary"
                onClick={() => onOpen("#/workspace")}
              >
                Review in Devices &amp; backup
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {data.operations.length > 0 ? (
        <div className="group" aria-labelledby="approvals-heading">
          <h3 id="approvals-heading" className="group-title">
            Approvals <Badge tone="count">{data.operations.length}</Badge>
          </h3>
          <div className="request-list">
            {data.operations.map((op) => (
              <ApprovalCard
                key={op.id}
                operation={op}
                names={names}
                onOpen={onOpen}
                onDone={onQuickDone}
                onError={onError}
              />
            ))}
          </div>
        </div>
      ) : null}

      {data.secrets.length > 0 ? (
        <div className="group" aria-labelledby="secrets-heading">
          <h3 id="secrets-heading" className="group-title">
            Secret requests <Badge tone="count">{data.secrets.length}</Badge>
          </h3>
          <div className="request-list">
            {data.secrets.map((request) => (
              <SecretCard
                key={request.id}
                request={request}
                names={names}
                onOpen={onOpen}
                onDone={onQuickDone}
                onError={onError}
              />
            ))}
          </div>
        </div>
      ) : null}

      {total > 0 && setup && onSetupChanged ? (
        <SetupChecklist
          status={setup}
          onOpen={onOpen}
          onChanged={onSetupChanged}
          onError={onError}
        />
      ) : null}

      <p className="small muted">
        {data.loadedAt
          ? `Last checked ${relativeTime(data.loadedAt)}.`
          : "Checking the broker…"}
      </p>
    </>
  );
}

// The assistant as a name with an icon, so the owner knows who is asking.
function AssistantTag({ id, names }: { id: string; names: AssistantNames }) {
  return (
    <span className="assistant-tag">
      <Icon name="bot" />
      {displayName(id, names)}
    </span>
  );
}

// Quiet meta: "Asked just now · expires in 15 minutes".
function RequestMeta({ asked, expires }: { asked?: number; expires?: number }) {
  const parts = [
    asked !== undefined ? `Asked ${relativeTime(asked)}` : undefined,
    expires !== undefined ? waitingUntil(expires) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? (
    <p className="request-meta">{parts.join(" · ")}</p>
  ) : null;
}

function ApprovalCard({
  operation: op,
  names,
  onOpen,
  onDone,
  onError,
}: {
  operation: PendingOperation;
  names: AssistantNames;
  onOpen: (hash: string) => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [askingPassword, setAskingPassword] = useState(false);
  // The badge says what the action does; the stripe colour still follows the tier.
  const risk = actionView(op);
  const expires = toEpoch(op.expiresAt);
  const asked = toEpoch(op.createdAt);
  const quick = canApproveFromList(op);
  const needsStepUp = op.decision.stepUp === true;
  const stepUpGrace = needsStepUp && Date.now() < getRecentStepUpUntil();
  const canInlineApprove = !op.setup;

  const decide = async (
    kind: Extract<ApprovalDecision, "approve-once" | "deny-once">,
    typedPassword?: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<DecideResult & { stepUpUntil?: number }>(
        "/v1/owner/decide",
        {
          operationId: op.id,
          fingerprint: op.fingerprint,
          decision: kind,
          ...(kind === "approve-once" && typedPassword
            ? { password: typedPassword }
            : {}),
        },
      );
      if (typeof result.stepUpUntil === "number")
        setRecentStepUpUntil(result.stepUpUntil);
      setAskingPassword(false);
      onDone(OUTCOME[result.operation.state] ?? DECISION_NOTICE[kind]);
    } catch (failure) {
      setRecentStepUpUntil(0);
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const approveClick = () => {
    if (needsStepUp && !stepUpGrace) {
      setAskingPassword(true);
      return;
    }
    void decide("approve-once");
  };

  return (
    <div className="item request-card" data-risk={risk.stripe}>
      <div className="request-head">
        <AssistantTag id={op.client} names={names} />
        <div className="row">
          {isUnderReview(op.decision.source) ? (
            <Badge tone="warn">Under review</Badge>
          ) : null}
          <Badge tone={risk.tone} icon={risk.icon}>
            {risk.label}
          </Badge>
        </div>
      </div>
      <p className="lead">
        <MachineText
          text={
            op.setup
              ? `${setupTitle(op).replace(/\?$/, "")}.`
              : op.proxmox
                ? `${proxmoxTitle(op).replace(/\?$/, "")}.`
                : `Wants to ${plainAction(op.argv)} on ${op.host}.`
          }
          machines={[op.host]}
        />
      </p>
      <div className="command-block">
        <Argv argv={op.argv} />
      </div>
      <p className="small muted">{riskLine(risk.stripe, !quick)}</p>
      <RequestMeta asked={asked} expires={expires} />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {askingPassword ? (
        <InlineApprovalPassword
          busy={busy}
          onConfirm={(typed) => void decide("approve-once", typed)}
          onCancel={() => setAskingPassword(false)}
        />
      ) : (
        <div className="request-actions">
          {canInlineApprove ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={approveClick}
              >
                Approve
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void decide("deny-once")}
              >
                Deny
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() =>
                  onOpen(`#/approvals/${encodeURIComponent(op.id)}`)
                }
              >
                Details
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  onOpen(`#/approvals/${encodeURIComponent(op.id)}`)
                }
              >
                Review
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void decide("deny-once")}
              >
                Deny
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
