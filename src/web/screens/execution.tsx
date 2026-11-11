// Operation details shown before a run, and the result card after it.
import { displayStateOf, durationText, shellArgv } from "../format";
import { Facts, Pre, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Disclosure } from "../disclosure";
import type { ControlExecution, ControlOp } from "../types";

export function classificationTone(op: ControlOp): Tone {
  if (op.classification === "destructive") return "danger";
  if (op.classification === "inspect") return "neutral";
  return "warning";
}

export function ExecutionDetails({ op }: { op: ControlOp }) {
  return (
    <div className="grid gap-3 text-sm">
      <p>
        <Tag tone={classificationTone(op)}>{op.classification}</Tag>{" "}
        {op.classification === "destructive" ? (
          <strong className="text-destructive-foreground">
            This operation can delete or overwrite data.
          </strong>
        ) : null}
      </p>
      <Facts
        items={[
          ["Host", op.host],
          ["Command", <code key="c">{shellArgv(op.argv)}</code>],
          ["Impact", op.impact || "—"],
          ["Fingerprint", <code key="f">{op.fingerprint}</code>],
          ["Approver", op.approval?.approver ?? "none needed (inspection)"],
        ]}
      />
    </div>
  );
}

export function ExecutionResult({ r }: { r: ControlExecution }) {
  const op = r.operation;
  const ok = op.state === "succeeded";
  const headline = ok
    ? `✓ succeeded on ${op.host} (exit ${op.exitCode ?? 0})`
    : op.state === "failed" && op.exitCode !== undefined
      ? `✗ failed (exit ${op.exitCode})`
      : `${displayStateOf(op)}${op.reason ? ` · ${op.reason}` : ""}`;
  const took = durationText(op);
  const out = r.output?.stdout ?? "";
  const err = r.output?.stderr ?? "";
  return (
    <section
      id="control-result"
      tabIndex={-1}
      aria-labelledby="control-result-title"
      className="mt-8 rounded-panel border border-border bg-card p-6 outline-none focus-visible:ring-2 focus-visible:ring-ring max-[700px]:p-[18px]"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="control-result-title" className="text-xl font-semibold tracking-[-0.015em]">
          Execution result
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close execution result"
          data-action="control-result-close"
        >
          ×
        </Button>
      </div>
      <p>
        <strong>{headline}</strong>
        {took ? <span className="text-muted-foreground"> · took {took}</span> : null}
      </p>
      <p className="text-muted-foreground">
        <code>$ {shellArgv(op.argv)}</code>
      </p>
      {!out.trim() && !err.trim() ? (
        <p className="text-muted-foreground">(no output)</p>
      ) : (
        <div className="grid gap-3">
          <ResultBlock title="stdout" text={out} />
          <ResultBlock title="stderr" text={err} />
        </div>
      )}
    </section>
  );
}

// A long stream folds away; short ones show at once.
function ResultBlock({ title, text }: { title: string; text: string }) {
  const body = text.trimEnd();
  if (!body.trim()) return null;
  const lines = body.split("\n").length;
  return (
    <Disclosure title={<>{title} · {lines} line{lines === 1 ? "" : "s"}</>} compact>
        <Pre>{body}</Pre>
      </Disclosure>
  );
}
