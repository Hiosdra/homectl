// Vault, as in the approved design, in two parts: access (the SSH session and the safe, which
// holds encrypted credentials) and the machines, with each machine's SSH key in its row.
// Nothing here leaves this device.
import type { ReactNode } from "react";
import { HelpLabel } from "../help";
import { formatLocalDate } from "../format";
import { ui } from "../store";
import { Action, Muted, Note, PageHeading, Section, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MachinesCard } from "./machines";
import { Output } from "./output";

export function Vault() {
  return (
    <>
      <PageHeading
        title="Vault"
        description="Session, secrets, keys and machines stay on this device. Pairing does not unlock another computer."
      />
      <div className="grid gap-5">
        <AccessCard />
        <MachinesCard />
      </div>
      <Output />
    </>
  );
}

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <Tag tone={tone}>{children}</Tag>;
}

function AccessCard() {
  return (
    <Section title="Access">
      <div className="grid gap-5">
        <SessionBlock />
        <SafeBlock />
      </div>
    </Section>
  );
}

// One part of the access card: its heading with a status, then its content.
function Block({ title, status, children }: { title: string; status: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">{title}</h3>
        {status}
      </div>
      {children}
    </div>
  );
}

function SessionBlock() {
  const unlocked = ui.state.session.unlocked;
  const tokens = (ui.control?.clients ?? []).filter((c) => c.hasToken && !c.revoked);
  return (
    <Block title="SSH session" status={<Badge tone={unlocked ? "success" : "neutral"}>{unlocked ? "unlocked" : "locked"}</Badge>}>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{unlocked && ui.state.session.expiresAt ? formatLocalDate(ui.state.session.expiresAt) : "—"}</dd>
        <dt className="text-muted-foreground">Keys</dt>
        <dd>{unlocked ? "loaded for this session" : "none loaded"}</dd>
        <dt className="text-muted-foreground">API tokens</dt>
        <dd>{tokens.length ? `${tokens.length} (${tokens.map((c) => c.name).join(", ")})` : "none"}</dd>
      </dl>
      <Muted>The keys for your machines are loaded only while the session is unlocked.</Muted>
      <div className="flex justify-end">
        <Action action="lock" label="Lock access" kind="secondary" />
      </div>
    </Block>
  );
}

function SafeBlock() {
  const exists = ui.state.vaultExists;
  const unlocked = ui.state.vaultUnlocked;
  return (
    <Block title="Safe (credential sync)" status={<Badge tone={unlocked ? "success" : "neutral"}>{unlocked ? "unlocked" : "locked"}</Badge>}>
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
    </Block>
  );
}
