// Machines, inside the Vault: the SSH hosts with their connection, access and status. Add
// and edit open a side panel with the form; the ⋯ menu offers Edit and Remove.
import { useState } from "react";
import { accessLabel } from "../format";
import { HelpLabel } from "../help";
import { Disclosure } from "../disclosure";
import { render, ui } from "../store";
import { Action, Cell, DataTable, Note, Row, Section, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { Machine } from "../types";
import { cn } from "../lib/utils";

export function MachinesCard() {
  const hosts = Object.entries(ui.state.inventory.machines);
  const form = ui.editing !== undefined;
  return (
    <Section title="Machines" id="machines">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground">SSH hosts and this device. Every operation has an explicit target.</p>
        <Action action="add" label="Add machine" kind="primary" />
      </div>
      <div className={cn("grid gap-5", form && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
        <div className="min-w-0 grid gap-4">
          <input
            id="filter"
            type="search"
            placeholder="Filter by name, address or description"
            autoComplete="off"
            value={ui.filterText}
            onChange={(e) => {
              ui.filterText = e.target.value;
              render();
            }}
            className="h-9 w-full max-w-[420px] rounded-lg border border-input bg-background px-3 text-sm"
          />
          {hosts.length ? (
            <DataTable head={["Machine", "Connection", "Access", "Status", "Key", ""]}>
              {hosts.map(([name, m]) => (
                <MachineRow key={name} name={name} m={m} />
              ))}
            </DataTable>
          ) : (
            <p className="text-muted-foreground">Add an SSH machine, or bring in a setup from another computer.</p>
          )}
          <CreateKey />
        </div>
        {form ? <MachineForm /> : null}
      </div>
    </Section>
  );
}

// Creates a machine's SSH key in the Vault. The key takes the machine's name.
function CreateKey() {
  return (
    <Disclosure title="Create SSH key">
      <form id="key-form" className="grid gap-3">
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="key-name" label="Key and machine name" help="The name of the SSH key and of the machine it belongs to. Use the same name as the machine, for example voron." />
          <Input id="key-name" name="name" pattern="[a-z][a-z0-9-]{0,62}" placeholder="storage-nas" required />
        </div>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="key-password" label="Safe password" help="The safe password. It is needed to create the key." />
          <Input id="key-password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <div className="flex justify-end">
          <Button type="submit">Create SSH key</Button>
        </div>
      </form>
      <Note>You’ll get the public key to install on the machine. Creating a key locks SSH access; unlock again afterwards.</Note>
    </Disclosure>
  );
}

function StatusCell({ name, local }: { name: string; local: boolean }) {
  if (local) return <span className="text-muted-foreground">—</span>;
  const status = ui.machineStatus[name];
  if (!status) return <span className="text-muted-foreground">not checked</span>;
  const tone: Tone = status.ok ? "success" : "danger";
  return (
    <Tag tone={tone}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {status.text}
    </Tag>
  );
}

function MachineRow({ name, m }: { name: string; m: Machine }) {
  const [menu, setMenu] = useState(false);
  const local = m.transport === "local";
  const search = [name, m.address, m.description].join(" ").toLowerCase();
  const hidden = ui.filterText !== "" && !search.includes(ui.filterText.toLowerCase());
  return (
    <Row search={search} hidden={hidden}>
      <Cell label="Machine" className="font-semibold">
        {name}
        <p className="text-xs font-normal text-muted-foreground">{m.description}</p>
      </Cell>
      <Cell label="Connection">
        {local ? (
          "This device"
        ) : (
          <>
            <code className="font-mono text-[12px]">{m.address}</code>
            <p className="text-xs text-muted-foreground">{m.user} · SSH</p>
          </>
        )}
      </Cell>
      <Cell label="Access">
        <Tag>{accessLabel(m.access)}</Tag>
      </Cell>
      <Cell label="Status">
        <StatusCell name={name} local={local} />
      </Cell>
      <Cell label="Key">
        {local ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Tag tone={ui.state.vaultUnlocked ? "success" : "neutral"}>{ui.state.vaultUnlocked ? "in safe" : "safe locked"}</Tag>
        )}
      </Cell>
      <Cell label="Actions">
        <div className="flex flex-wrap items-center gap-1.5">
          <Action action="doctor" label="Check" id={name} kind="quiet" />
          <Action action="command" label="Command" id={name} kind="quiet" />
          {local ? null : (
            <div className="relative">
              <Button type="button" variant="ghost" size="sm" aria-expanded={menu} aria-label={`More actions for ${name}`} onClick={() => setMenu(!menu)}>
                ⋯
              </Button>
              {menu ? (
                <div className="absolute right-0 z-10 mt-1 grid min-w-32 gap-1 rounded-lg border border-border bg-popover p-1 shadow-md">
                  <Action action="edit" label="Edit" id={name} kind="quiet" />
                  <Action action="machine-delete" label="Remove" id={name} kind="quiet-danger" />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Cell>
    </Row>
  );
}

// The add and edit form, in the side panel next to the table.
export function MachineForm() {
  const m = ui.editing !== undefined ? ui.state.inventory.machines[ui.editing] : undefined;
  const access = [
    ["observe", "Read-only (observe)"],
    ["user", "Standard user (user)"],
    ["sudo-approved", "Approved admin commands (sudo-approved)"],
    ["full", "Full account (full)"],
  ] as const;
  return (
    <aside className="grid content-start gap-4 rounded-panel border border-border bg-popover p-5" aria-label="Machine form">
      <h3 className="text-lg font-semibold">{m ? "Edit machine" : "Add SSH host"}</h3>
      <p className="text-sm text-muted-foreground">
        Create a key in Vault with the same name as this machine, install its public key on the host, and
        verify the host fingerprint. homectl links the matching key automatically.
      </p>
      <form id="machine-form" key={ui.editing} className="grid gap-3">
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="machine-name" label="Name" help="The name you use in commands, for example homectl exec voron. Lowercase letters, numbers and dashes. It cannot be changed later." />
          <Input id="machine-name" name="name" pattern="[a-z][a-z0-9-]{0,62}" defaultValue={ui.editing} required readOnly={m !== undefined} />
        </div>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="machine-address" label="Address" help="The IP address or host name of the machine on your network, for example 192.168.1.20." />
          <Input id="machine-address" name="address" defaultValue={m?.address} required />
        </div>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="machine-user" label="SSH account" help="The user name homectl logs in with over SSH. Use an account set up for this purpose, not your personal one." />
          <Input id="machine-user" name="user" defaultValue={m?.user} required />
        </div>
        <div className="grid gap-1.5">
          <HelpLabel
            htmlFor="machine-access"
            label="Access"
            help="What homectl may do here. Read-only only looks. Standard user runs commands as the SSH account. Approved admin commands runs only the admin commands listed under Advanced SSH settings. Full account can do anything the account can. Start with Read-only."
          />
          <Select name="access" items={access.map(([value, label]) => ({ value, label }))} defaultValue={m?.access ?? "observe"}>
            <SelectTrigger id="machine-access" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {access.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <HelpLabel htmlFor="machine-description" label="Description" help="A short note for people and clients, for example Printer on the workshop shelf." />
          <Input id="machine-description" name="description" defaultValue={m?.description} required />
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Advanced SSH settings</summary>
          <div className="mt-2 grid gap-3">
            <Note>Most machines need none of these. Leave them empty to use the defaults.</Note>
            <div className="grid gap-1.5">
              <HelpLabel
                htmlFor="machine-port"
                label="SSH port"
                help="The SSH port on the machine. Leave it empty for the standard port 22."
              />
              <Input id="machine-port" name="port" type="number" inputMode="numeric" min={1} max={65535} placeholder="22" defaultValue={m?.port ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <HelpLabel
                htmlFor="machine-caution"
                label="Cautions"
                help="Warnings shown before a command runs on this machine, one per line. For example: Do not restart while a print is running."
              />
              <Textarea id="machine-caution" name="caution" defaultValue={(m?.caution ?? []).join("\n")} />
            </div>
            <div className="grid gap-1.5">
              <HelpLabel
                htmlFor="machine-sudo"
                label="Admin commands"
                help="Commands allowed to run with sudo, one per line, written as you would type them, for example: systemctl restart klipper. Used only with Approved admin commands access."
              />
              <Textarea id="machine-sudo" name="sudo_allow" defaultValue={(m?.sudo_allow ?? []).map((argv) => argv.join(" ")).join("\n")} />
            </div>
            <div className="grid gap-1.5">
              <HelpLabel
                htmlFor="machine-enforcement"
                label="Enforcement"
                help="Advisory: homectl checks the admin rules itself. Sudoers file: the rules are also enforced on the machine by a sudoers file, which you create with homectl sudoers."
              />
              <Select
                name="enforcement"
                items={[
                  { value: "advisory", label: "Advisory (homectl checks the rules)" },
                  { value: "sudoers", label: "Sudoers file (enforced on the machine)" },
                ]}
                defaultValue={m?.enforcement ?? "advisory"}
              >
                <SelectTrigger id="machine-enforcement" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="advisory">Advisory (homectl checks the rules)</SelectItem>
                  <SelectItem value="sudoers">Sudoers file (enforced on the machine)</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {m?.auth ? (
              <div className="grid gap-1.5">
                <HelpLabel
                  htmlFor="machine-key"
                  label="Vault key entry"
                  help="The name of this machine's SSH key in the Vault. Change it only if you renamed the key."
                />
                <Input id="machine-key" name="key_entry" defaultValue={m.auth.entry} />
              </div>
            ) : null}
          </div>
        </details>
        <div className="flex flex-wrap justify-end gap-2">
          {m ? <Action action="machine-delete" label="Remove machine" id={ui.editing} kind="quiet-danger" /> : null}
          <Action action="cancel-edit" label="Cancel" />
          <Button type="submit">Save machine</Button>
        </div>
      </form>
    </aside>
  );
}
