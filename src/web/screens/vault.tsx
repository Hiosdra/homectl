import { HelpLabel } from "../help";
// Vault, as in the approved design: the SSH session, the safe (encrypted credentials), the
// recovery key, the machines, and the SSH keys. Nothing here leaves this device.
import { formatLocalDate } from "../format";
import { ui } from "../store";
import { Action, Muted, Note, PageHeading, Section, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Disclosure } from "../disclosure";
import { MachinesCard } from "./machines";
import { Output } from "./output";

export function Vault() {
  return (
    <>
      <PageHeading
        title="Vault"
        description="Session, secrets, keys and machines stay on this device. Pairing does not unlock another computer."
      />
      <div className="grid gap-5 md:grid-cols-2">
        <SessionCard />
        <SafeCard />
      </div>
      <div className="mt-5">
        <RecoveryCard />
      </div>
      <div className="mt-5">
        <MachinesCard />
      </div>
      <div className="mt-5">
        <KeysCard />
      </div>
      <Output />
    </>
  );
}

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <Tag tone={tone}>{children}</Tag>;
}

function SessionCard() {
  const unlocked = ui.state.session.unlocked;
  const tokens = (ui.control?.clients ?? []).filter((c) => c.hasToken && !c.revoked);
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          SSH session <Badge tone={unlocked ? "success" : "neutral"}>{unlocked ? "unlocked" : "locked"}</Badge>
        </span>
      }
    >
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{unlocked && ui.state.session.expiresAt ? formatLocalDate(ui.state.session.expiresAt) : "—"}</dd>
        <dt className="text-muted-foreground">Keys</dt>
        <dd>{unlocked ? "loaded for this session" : "none loaded"}</dd>
        <dt className="text-muted-foreground">API tokens</dt>
        <dd>{tokens.length ? `${tokens.length} (${tokens.map((c) => c.name).join(", ")})` : "none"}</dd>
      </dl>
      <div className="mt-4 flex justify-end">
        <Action action="lock" label="Lock access" kind="secondary" />
      </div>
    </Section>
  );
}

function SafeCard() {
  const exists = ui.state.vaultExists;
  const unlocked = ui.state.vaultUnlocked;
  return (
    <Section
      title={
        <span className="flex items-center justify-between gap-3">
          Safe (credential sync) <Badge tone={unlocked ? "success" : "neutral"}>{unlocked ? "unlocked" : "locked"}</Badge>
        </span>
      }
    >
      {unlocked ? (
        <Muted>Credential sync is ready on this device. SSH access is managed separately.</Muted>
      ) : (
        <form id="unlock-form" key={exists ? "unlock" : "create"} className="grid gap-3">
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="password" label="Safe password" help="The safe holds the credentials that sync between your computers. Its password is separate from the SSH session and never leaves this device." />
            <Input id="password" name="password" type="password" autoComplete={exists ? "current-password" : "new-password"} required />
          </div>
          {exists ? null : (
            <>
              <div className="grid gap-1.5">
                <HelpLabel htmlFor="password-confirm" label="Confirm safe password" help="Type the same password again, so a typing mistake does not go unnoticed." />
                <Input id="password-confirm" name="password-confirm" type="password" autoComplete="new-password" required />
              </div>
              <input type="hidden" name="create" value="true" />
            </>
          )}
          <div>
            <Button type="submit">{exists ? "Unlock safe" : "Create and unlock safe"}</Button>
          </div>
        </form>
      )}
      <Note>The password stays on this device. It is never sent to peers or saved in logs.</Note>
    </Section>
  );
}

const EXPORT_COMMAND = "homectl control recovery export --key <path> --out <path>";

function RecoveryCard() {
  const last = ui.control?.recovery?.lastExportAt;
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : undefined;
  // A week without an export is flagged, as in the approved design.
  const stale = days === undefined || days > 7;
  return (
    <Section
      title={
        <span className="flex flex-wrap items-center justify-between gap-3">
          Recovery key
          <Badge tone={stale ? "warning" : "success"}>
            {days === undefined
              ? "no backup recorded"
              : days === 0
                ? "backup today"
                : stale
                  ? `no backup for ${days} days`
                  : `backup ${days} days ago`}
          </Badge>
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

function KeysCard() {
  const machines = Object.entries(ui.state.inventory.machines).filter(([, m]) => m.transport !== "local");
  return (
    <Section title="SSH keys">
      <Muted>Keys by machine, with installation status.</Muted>
      <div className="mt-4 grid gap-2">
        {machines.length ? (
          machines.map(([name]) => (
            <div key={name} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
              <div>
                <b>{name}</b> <span className="text-sm text-muted-foreground">key {name}</span>
              </div>
              <Tag tone={ui.state.vaultUnlocked ? "success" : "neutral"}>{ui.state.vaultUnlocked ? "in safe" : "safe locked"}</Tag>
            </div>
          ))
        ) : (
          <Muted>No SSH machines yet. Add one under Machines.</Muted>
        )}
      </div>
      <div className="mt-4">
        <Disclosure title="Create key">
          <form id="key-form" className="grid gap-3">
            <div className="grid gap-1.5">
              <HelpLabel htmlFor="key-name" label="Key and machine name" help="The name of the SSH key and of the machine it belongs to. Use the same name as the machine, for example voron." />
              <Input id="key-name" name="name" pattern="[a-z][a-z0-9-]{0,62}" placeholder="storage-nas" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-password">Safe password</Label>
              <Input id="key-password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <div className="flex justify-end">
              <Button type="submit">Create SSH key</Button>
            </div>
          </form>
          <Note>
            You’ll get the public key to install on the machine. Creating a key locks SSH access; unlock again afterwards.
          </Note>
        </Disclosure>
      </div>
    </Section>
  );
}
