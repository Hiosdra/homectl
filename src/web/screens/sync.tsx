// The sync comparison as one screen: the changes to review, the conflicts with a choice
// for each, and the footer that applies them. Both versions of a conflict get equal
// space; the later change is pre-selected, but the person still chooses.
import { localStamp } from "../format";
import { syncWaitVisible, ui } from "../store";
import type { Preview } from "../types";
import { Action, Muted, Note, PageHeading, Tag } from "../shared";
import { Button } from "../ui/button";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Disclosure } from "../disclosure";
import { cn } from "../lib/utils";

type Conflict = Preview["conflicts"][number];
type Side = "local" | "remote";

const SIDE_LABEL: Record<string, string> = {
  machine: "Machine",
  credential: "Credential",
  hostkey: "Trusted host key",
  provider: "Provider",
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const display = (value: unknown) =>
  value === undefined || value === null || value === "" ? "—" : String(value);

// One card per changed entry: what changed, field by field, for one version or the diff.
export function syncChangeCards(
  entries: NonNullable<Preview["entries"]>,
  versionOnly = false,
) {
  return entries.map(({ id, local, remote }) => {
    const [type, ...parts] = id.split(":");
    const name = parts.join(":");
    const label = SIDE_LABEL[type ?? ""] ?? "Entry";
    const before = local?.value ?? null;
    const after = remote.value;
    const action = versionOnly
      ? after === null
        ? "Deleted"
        : "Current version"
      : after === null
        ? "Remove"
        : before === null
          ? "Add"
          : "Update";
    const fields =
      type === "machine"
        ? ["description", "address", "user", "access", "transport"]
        : type === "provider"
          ? ["type", "host", "node"]
          : [];
    const left = object(before);
    const right = object(after);
    const details = fields.filter(
      (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
    );
    const note =
      type === "credential"
        ? "Secret contents stay hidden."
        : type === "hostkey"
          ? "Review the host fingerprint independently before trusting it."
          : "";
    return (
      <article key={id} className="min-w-0 rounded-lg border border-border bg-background p-4">
        <h3 className="mb-2 text-[15px] font-semibold break-words">
          {label}: {name}
        </h3>
        <Tag>{action}</Tag>
        {details.length ? (
          <dl className="mt-3 grid gap-2">
            {details.map((key) => (
              <div key={key}>
                <dt className="text-muted-foreground capitalize">{key}</dt>
                <dd className="m-0 break-words">
                  {before !== null ? `${display(left[key])} → ` : ""}
                  {display(right[key])}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {note ? <Note>{note}</Note> : null}
      </article>
    );
  });
}

function sideName(p: Preview, side: Side) {
  return side === "local" ? p.localName : p.remoteName;
}

// The name of a choice. A removed side is kept removed or restored; otherwise it is
// the device the version came from.
function optionLabel(p: Preview, conflict: Conflict, side: Side) {
  const other: Side = side === "local" ? "remote" : "local";
  if (conflict[side].value === null) return "Keep removed";
  if (conflict[other].value === null) return "Restore";
  return `Use from ${sideName(p, side)}`;
}

function stamp(at?: number) {
  return at === undefined ? "" : localStamp(new Date(at).toISOString());
}

function removedNote(p: Preview, conflict: Conflict, suggested: Side | undefined) {
  const removed: Side = conflict.local.value === null ? "local" : "remote";
  const kept: Side = removed === "local" ? "remote" : "local";
  const removedAt = stamp(conflict[removed].at);
  const keptAt = stamp(conflict[kept].at);
  const keptText = `${sideName(p, kept)} still has it${keptAt ? `, last changed ${keptAt}` : ""}.`;
  const outcome =
    suggested === removed
      ? "The removal is the later change, so the default keeps it removed."
      : "The version with data is the later change, so the default restores it.";
  return `Removed on ${sideName(p, removed)}${removedAt ? ` ${removedAt}` : ""}. ${keptText} ${outcome}`;
}

// The status of the sync and what the person must do before the other vault unlocks.
export function SyncWait() {
  if (!syncWaitVisible()) return null;
  const name =
    ui.preview?.remoteName ||
    ui.state.peers.find((p) => p.id === ui.syncWaiting?.peerId)?.name ||
    "the other device";
  return (
    <Alert variant="warning" className="mb-5" aria-labelledby="sync-wait-title">
      <AlertTitle id="sync-wait-title">Unlock the vault on {name}</AlertTitle>
      <AlertDescription>
        <p>
          On {name}, open homectl → Vault → Unlock vault, or run this command in a
          private terminal:
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <code>homectl session unlock</code>
          <Action action="sync-copy-unlock" label="Copy command" />
        </div>
        <p id="sync-wait-status" role="status" className="mt-2 text-muted-foreground">
          {ui.syncWaitStatus}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function VersionBox({
  p,
  side,
  conflict,
  title,
  tag,
}: {
  p: Preview;
  side: Side;
  conflict: Conflict;
  title: string;
  tag: string;
}) {
  const at = stamp(conflict[side].at);
  return (
    <div className="grid content-start gap-2.5 rounded-lg border border-border bg-background p-4.5 max-[700px]:p-4">
      <h3 className="flex flex-wrap items-center justify-between gap-2 text-[15px] font-semibold">
        {title} <Tag>{tag}</Tag>
      </h3>
      {at ? <Note>Changed {at}</Note> : null}
      {syncChangeCards([{ id: conflict.id, local: null, remote: conflict[side] }], true)}
    </div>
  );
}

function ConflictCard({ p, index, conflict }: { p: Preview; index: number; conflict: Conflict }) {
  const choice = ui.conflictChoice[index];
  const removal = conflict.local.value === null || conflict.remote.value === null;
  const suggested = conflict.suggested;
  const options: { value: string; label: string; isDefault: boolean }[] = [
    "local",
    "remote",
  ].map((side) => ({
    value: side,
    label: optionLabel(p, conflict, side as Side),
    isDefault: suggested === side,
  }));
  if (!conflict.id.startsWith("hostkey:") && !removal)
    options.push({ value: "both", label: "Keep both as separate entries", isDefault: false });
  const title = conflict.id;
  const choiceText =
    choice === "both"
      ? "The received version will be copied to a new entry."
      : choice === "remote"
        ? p.remoteName
        : p.localName;
  return (
    <section
      className={cn(
        "grid gap-4 rounded-panel border border-border bg-card p-5 max-[700px]:p-4",
        choice !== undefined && "border-[#4b3f7a] bg-[#1d1a33]",
      )}
      data-conflict={index}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex min-w-0 flex-wrap items-center gap-2 text-base font-semibold">
          <code className="font-mono text-[13px] break-all">{title}</code>
          <Tag tone="warning">conflict</Tag>
          {removal ? <Tag tone="danger">removed here</Tag> : null}
        </h2>
      </header>
      {removal ? <Note>{removedNote(p, conflict, suggested)}</Note> : null}
      {choice === undefined ? (
        <div className="grid gap-3 md:grid-cols-2">
          <VersionBox p={p} side="local" conflict={conflict} title={p.localName} tag="Local" />
          <VersionBox p={p} side="remote" conflict={conflict} title={p.remoteName} tag="Received" />
        </div>
      ) : (
        <div className="grid gap-2 rounded-lg border border-[#4b3f7a] p-4" role="status">
          <h3 className="text-[15px] font-semibold">
            {choice === "both" ? "Both versions kept" : "Selected version"}
          </h3>
          <Muted>{choiceText}</Muted>
          {choice === "both" ? (
            <div className="grid gap-3 md:grid-cols-2">
              {(["local", "remote"] as Side[]).map((side) => (
                <div key={side}>
                  {syncChangeCards([{ id: conflict.id, local: null, remote: conflict[side] }], true)}
                </div>
              ))}
            </div>
          ) : (
            syncChangeCards([
              {
                id: conflict.id,
                local: null,
                remote: conflict[choice === "remote" ? "remote" : "local"],
              },
            ], true)
          )}
          <div>
            <Action action="compare-conflict" label="Compare again" id={String(index)} kind="quiet" />
          </div>
        </div>
      )}
      <fieldset className="grid gap-2.5">
        <legend className="mb-1 text-sm text-muted-foreground">Choose the final result</legend>
        {options.map((option) => (
          <label key={option.value} className="flex flex-wrap items-center gap-2.5">
            <input
              type="radio"
              name={`choice-${index}`}
              value={option.value}
              required
              defaultChecked={option.isDefault}
              className="size-4 accent-primary"
            />
            <span>{option.label}</span>
            {option.isDefault ? <Tag tone="info">default · later change</Tag> : null}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

// The whole comparison on one screen; the device list is not shown while it is open.
export function SyncCompare({ p }: { p: Preview }) {
  const count = p.changes.length;
  return (
    <>
      <PageHeading
        title={`Sync: ${p.localName} ↔ ${p.remoteName}`}
        description="Both sides can change data. Each conflict defaults to the later change. You choose the final result."
      />
      <SyncWait />
      <form id="sync-form" key={p.id} className="grid gap-5">
        <p className="text-sm text-muted-foreground">
          {count} changed entr{count === 1 ? "y" : "ies"} · {p.conflicts.length} conflict
          {p.conflicts.length === 1 ? "" : "s"}. Only conflicts need your choice. Secrets
          stay hidden.
        </p>
        {p.conflicts.map((c, i) => (
          <ConflictCard key={c.id + i} p={p} index={i} conflict={c} />
        ))}
        <Disclosure title={<>Changes to review</>} panelClassName="pt-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {p.entries
                ? syncChangeCards(p.entries)
                : p.changes.map((id) => (
                    <article key={id} className="rounded-lg border border-border bg-background p-4">
                      <h3 className="text-[15px] font-semibold break-words">{id}</h3>
                    </article>
                  ))}
            </div>
          </Disclosure>
        <footer className="flex flex-wrap justify-end gap-2.5">
          <Action action="sync-cancel" label="Close" />
          {ui.syncPeerId ? (
            <Action action="sync-restart" label="Compare devices again" />
          ) : null}
          <Button type="submit" disabled={syncWaitVisible()}>
            Apply choices
          </Button>
        </footer>
      </form>
    </>
  );
}

