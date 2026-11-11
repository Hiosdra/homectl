// The recovery key, as a card in Settings. It is created and used in the terminal: the panel
// shows the export command and how long ago the last backup was taken.
import { Disclosure } from "../disclosure";
import { ui } from "../store";
import { Muted, Section, Tag, type Tone } from "../shared";

const EXPORT_COMMAND = "homectl control recovery export --key <path> --out <path>";

export function RecoveryCard() {
  const last = ui.control?.recovery?.lastExportAt;
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : undefined;
  // A week without an export is flagged, as in the approved design.
  const stale = days === undefined || days > 7;
  const tone: Tone = stale ? "warning" : "success";
  const label =
    days === undefined ? "no backup recorded" : days === 0 ? "backup today" : stale ? `no backup for ${days} days` : `backup ${days} days ago`;
  return (
    <Section
      title={
        <span className="flex flex-wrap items-center justify-between gap-3">
          Recovery key <Tag tone={tone}>{label}</Tag>
        </span>
      }
    >
      <Muted>Stored outside your devices. Created and used in the terminal.</Muted>
      <pre className="mt-3 overflow-auto rounded-[7px] border border-border bg-muted p-4 font-mono text-[12px] whitespace-pre-wrap break-words max-[700px]:hidden">
        {EXPORT_COMMAND}
      </pre>
      {/* Phones keep the command behind a button, as in the mobile design. */}
      <Disclosure title="Show export command" className="mt-3 hidden max-[700px]:block">
        <pre className="overflow-auto rounded-[7px] border border-border bg-muted p-4 font-mono text-[12px] whitespace-pre-wrap break-words">
          {EXPORT_COMMAND}
        </pre>
      </Disclosure>
    </Section>
  );
}
