// Vault: the encrypted credential vault, the SSH session, and the SSH key form. The
// sections fold on phones, where the forms would otherwise fill the screen.
import type { ReactNode } from "react";
import { formatLocalDate, sessionTtlLabel } from "../format";
import { ui } from "../store";
import { Action, Facts, Muted, Note, PageHeading, Section, phoneView } from "../shared";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Output } from "./output";

// A section that folds. The heading is the trigger, so screen readers see its title.
function Fold({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Collapsible
      defaultOpen={!phoneView()}
      className={`rounded-panel border border-border bg-card p-6 max-[700px]:p-[18px] ${className ?? ""}`}
    >
      <h2 className="text-xl font-semibold tracking-[-0.015em]">
        <CollapsibleTrigger className="cursor-pointer text-left">{title}</CollapsibleTrigger>
      </h2>
      <CollapsiblePanel className="pt-3">{children}</CollapsiblePanel>
    </Collapsible>
  );
}

export function Vault() {
  const createVault = !ui.state.vaultExists;
  return (
    <>
      <PageHeading
        title="Vault"
        description="Vaults and sessions are local. Pairing does not unlock the other computer."
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Fold title="Encrypted vault">
          {ui.state.vaultUnlocked ? (
            <div className="rounded-dialog border border-dashed border-[#3b4c62] px-6 py-8 text-center">
              <h3 className="mb-2 text-base font-semibold">Vault unlocked</h3>
              <Muted>
                Credential sync is ready on this device. SSH access is managed separately.
              </Muted>
            </div>
          ) : (
            <>
              <Muted>
                {createVault
                  ? "Create an encrypted vault on this device."
                  : "Unlock this device’s encrypted vault to sync credentials."}
              </Muted>
              <form
                id="unlock-form"
                key={createVault ? "create" : "unlock"}
                className="mt-4 grid gap-4"
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="password">
                    {createVault ? "Choose a vault password" : "Vault password"}
                  </Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={createVault ? "new-password" : "current-password"}
                    required
                  />
                </div>
                {createVault ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="password-confirm">Confirm vault password</Label>
                      <Input
                        id="password-confirm"
                        name="password-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                      />
                    </div>
                    <input type="hidden" name="create" value="true" />
                  </>
                ) : null}
                <div>
                  <Button type="submit">
                    {createVault ? "Create and unlock vault" : "Unlock vault"}
                  </Button>
                </div>
              </form>
              <Note>
                The password stays on this device. It is never sent to peers or saved in
                logs.
              </Note>
            </>
          )}
        </Fold>
        <Section title="SSH session">
          <Facts
            items={[
              ["Status", ui.state.session.unlocked ? "Unlocked" : "Locked"],
              [
                "Expires",
                ui.state.session.unlocked
                  ? ui.state.session.expiresAt
                    ? formatLocalDate(ui.state.session.expiresAt)
                    : "On lock or restart"
                  : "—",
              ],
              [
                "Session lifetime",
                sessionTtlLabel(ui.state.inventory.session?.ttl ?? "24h"),
              ],
            ]}
          />
          <div className="mt-5 flex justify-end">
            <Action action="lock" label="Lock access" kind="quiet" />
          </div>
          <Note>
            Locking stops new SSH connections from using these keys. Already-connected
            sessions may continue.
          </Note>
        </Section>
      </div>
      <Fold title="Create an SSH key" className="mt-8">
        <Muted>
          Create a key for the machine you plan to add, then install its public key
          there.
        </Muted>
        <form id="key-form" className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">Key and machine name</Label>
            <Input
              id="key-name"
              name="name"
              pattern="[a-z][a-z0-9-]{0,62}"
              placeholder="storage-nas"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-password">Vault password</Label>
            <Input
              id="key-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="flex justify-end md:col-span-2">
            <Button type="submit">Create SSH key</Button>
          </div>
        </form>
        <Note>
          You’ll get the public key to install on the machine. Creating a key locks SSH
          access; unlock again afterwards.
        </Note>
      </Fold>
      <Output />
    </>
  );
}
