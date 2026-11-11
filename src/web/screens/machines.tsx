// Machines: the SSH hosts this device manages, with search, the add and edit form, and
// the operations waiting for approval.
import { accessLabel, displayArgv } from "../format";
import { ui, render } from "../store";
import type { Machine } from "../types";
import {
  Action,
  Cell,
  DataTable,
  EmptyState,
  Facts,
  ListRow,
  Note,
  PageHeading,
  Row,
  Section,
  Tag,
} from "../shared";
import { Button } from "../ui/button";
import { Disclosure } from "../disclosure";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Output } from "./output";

export function Machines() {
  const hosts = Object.entries(ui.state.inventory.machines);
  return (
    <>
      <PageHeading
        title="Machines"
        description="Your SSH hosts and this device. Every operation has an explicit target."
        actions={<Action action="add" label="Add machine" kind="primary" />}
      />
      {ui.state.operations?.length ? (
        <Section title="Operations awaiting your approval" className="mb-8">
          {ui.state.operations.map((o) => (
            <ListRow
              key={o.id}
              actions={
                <>
                  <Action action="operation-approve" label="Approve" id={o.id} kind="primary" />
                  <Action action="operation-reject" label="Reject" id={o.id} />
                </>
              }
            >
              <strong>
                {o.peerName} → {o.host}
              </strong>
              <pre className="mt-2 font-mono text-[12px] whitespace-pre-wrap">
                {displayArgv(o.argv)}
              </pre>
              <p className="text-sm text-muted-foreground">
                {o.impact ?? "Review the exact target and impact"}
              </p>
            </ListRow>
          ))}
        </Section>
      ) : null}
      {ui.editing !== undefined ? (
        <MachineForm />
      ) : (
        <>
          <div className="mb-4 grid gap-1.5 max-w-[320px]">
            <Label htmlFor="filter" className="text-muted-foreground">
              Find a machine
            </Label>
            <Input
              id="filter"
              type="search"
              placeholder="Name, address, or description"
              autoComplete="off"
              value={ui.filterText}
              onChange={(e) => {
                ui.filterText = e.target.value;
                render();
              }}
            />
          </div>
          {!hosts.length ? (
            <EmptyState
              title="Choose how to get started"
              actions={
                <>
                  <Action action="add" label="Add an SSH machine" kind="primary" />
                  <Action action="navigate-peers" label="Use another computer’s setup" />
                </>
              }
            >
              <p>Add an SSH machine, or bring in a setup from another computer.</p>
            </EmptyState>
          ) : (
            <DataTable head={["Machine", "Connection", "Access", "Operations"]}>
              {hosts.map(([name, m]) => (
                <MachineRow key={name} name={name} m={m} />
              ))}
            </DataTable>
          )}
          <Output />
        </>
      )}
    </>
  );
}

function MachineRow({ name, m }: { name: string; m: Machine }) {
  const search = [name, m.address, m.description].join(" ").toLowerCase();
  const hidden = ui.filterText !== "" && !search.includes(ui.filterText.toLowerCase());
  return (
    <Row search={search} hidden={hidden}>
      <Cell label="Machine" wide className="font-semibold">
        <span className="mr-2.5 inline-grid size-8 place-items-center rounded-lg border border-[#354a63] bg-[#25384e] align-middle text-[13px] font-semibold text-[#c4d4e7]" aria-hidden="true">
          {name.slice(0, 2).toUpperCase()}
        </span>
        <span className="inline-block align-middle">
          {name}
          <p className="mt-1 text-xs font-normal text-muted-foreground">{m.description}</p>
          <Disclosure title={<>Details</>} panelClassName="pt-2.5 text-xs font-normal">
              <Facts
                items={[
                  ["Transport", m.transport === "local" ? "This device" : "SSH"],
                  ["SSH account", m.user ?? "Local"],
                  ["Port", String(m.port ?? 22)],
                  ["SSH alias", String(m.ssh_alias ?? "—")],
                  [
                    "Cautions",
                    Array.isArray(m.caution) ? m.caution.join("; ") : "None recorded",
                  ],
                ]}
              />
            </Disclosure>
        </span>
      </Cell>
      <Cell label="Connection">
        {m.transport === "local" ? (
          "This device"
        ) : (
          <>
            <code>{m.address}</code>
            <p className="text-xs text-muted-foreground">{m.user} · SSH</p>
          </>
        )}
      </Cell>
      <Cell label="Access">
        <Tag>{accessLabel(m.access)}</Tag>
      </Cell>
      <Cell label="Operations">
        <div className="flex flex-wrap gap-1.5 max-[700px]:justify-start">
          <Action action="doctor" label="Check" id={name} />
          <Action action="command" label="Command" id={name} />
          {m.transport === "ssh" ? (
            <Action action="edit" label="Edit" id={name} kind="quiet" />
          ) : null}
        </div>
      </Cell>
    </Row>
  );
}

function MachineForm() {
  const m =
    ui.editing !== undefined ? ui.state.inventory.machines[ui.editing] : undefined;
  const extra = JSON.stringify(
    m
      ? Object.fromEntries(
          Object.entries(m).filter(
            ([k]) =>
              ![
                "address",
                "user",
                "description",
                "access",
                "transport",
                "ssh_alias",
              ].includes(k),
          ),
        )
      : {},
    null,
    2,
  );
  const access = [
    ["observe", "Read-only (observe)"],
    ["user", "Standard user (user)"],
    ["sudo-approved", "Approved admin commands (sudo-approved)"],
    ["full", "Full account (full)"],
  ] as const;
  return (
    <Section>
      <h2 className="mb-2 text-xl font-semibold">
        {m ? "Edit machine" : "Add SSH host"}
      </h2>
      <p className="text-muted-foreground">
        Create a key in Access with the same name as this machine, install its public
        key on the host, and verify the host fingerprint. homectl links the matching
        key automatically.
      </p>
      <form id="machine-form" key={ui.editing} className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="machine-name">Name</Label>
          <Input
            id="machine-name"
            name="name"
            pattern="[a-z][a-z0-9-]{0,62}"
            defaultValue={ui.editing}
            required
            readOnly={m !== undefined}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="machine-address">Address</Label>
          <Input id="machine-address" name="address" defaultValue={m?.address} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="machine-user">SSH account</Label>
          <Input id="machine-user" name="user" defaultValue={m?.user} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="machine-access">Access</Label>
          <Select
            name="access"
            items={access.map(([value, label]) => ({ value, label }))}
            defaultValue={m?.access ?? "observe"}
          >
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
        <div className="grid gap-1.5 md:col-span-2">
          <Label htmlFor="machine-description">Description</Label>
          <Input
            id="machine-description"
            name="description"
            defaultValue={m?.description}
            required
          />
        </div>
        <Disclosure title={<>Advanced SSH settings</>} className="md:col-span-2" panelClassName="grid gap-2 pt-3">
            <Note>
              Optional JSON fields for a non-default port, cautions, sudo rules, or a
              custom key reference.
            </Note>
            <Label htmlFor="machine-json">Additional fields (JSON)</Label>
            <Textarea id="machine-json" name="extra" defaultValue={extra} />
          </Disclosure>
        <div className="flex flex-wrap justify-end gap-2.5 md:col-span-2">
          {m ? (
            <Action
              action="machine-delete"
              label="Remove machine"
              id={ui.editing}
              kind="quiet-danger"
            />
          ) : null}
          <Action action="cancel-edit" label="Cancel" />
          <Button type="submit">Save machine</Button>
        </div>
      </form>
    </Section>
  );
}
