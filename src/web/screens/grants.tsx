import { HelpLabel } from "../help";
// Panels opened from a device or a host: the peer's grants, and a command to run.
import type { ReactNode } from "react";
import { accessLabel } from "../format";
import { ui } from "../store";
import { Action, Note, PageHeading, Section } from "../shared";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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

// One checkbox with its label. The name and value are what the form submits.
function Check({
  name,
  value,
  defaultChecked,
  children,
}: {
  name: string;
  value?: string;
  defaultChecked: boolean;
  children: ReactNode;
}) {
  return (
    <Label className="flex items-center gap-2.5 text-foreground">
      <Checkbox name={name} value={value} defaultChecked={defaultChecked} />
      {children}
    </Label>
  );
}

export function PermissionPanel({ id }: { id: string }) {
  const p = ui.state.peers.find((x) => x.id === id);
  if (!p) return null;
  return (
    <>
      <PageHeading
        title={`Permissions: ${p.name}`}
        description="These grants define what this peer can do on this computer."
      />
      <Section>
        <form id="permissions-form" key={id} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="permission-address">Peer address</Label>
            <Input
              id="permission-address"
              name="address"
              defaultValue={p.address}
              required
            />
          </div>
          <Check name="sync" defaultChecked={p.permissions.sync}>
            Sync entries
          </Check>
          <Check name="diagnostics" defaultChecked={p.permissions.diagnostics}>
            Inspect this device and its hosts
          </Check>
          <Check name="administer" defaultChecked={p.permissions.administer}>
            Operate on the computer running homectl
          </Check>
          <h3 className="mt-2 text-[15px] font-semibold">Hosts available for operations</h3>
          {Object.entries(ui.state.inventory.machines).map(([name, m]) => (
            <Check
              key={name}
              name="hosts"
              value={name}
              defaultChecked={p.permissions.operations.includes(name)}
            >
              {name} <span className="text-muted-foreground">{accessLabel(m.access)}</span>
            </Check>
          ))}
          <Note>Changes require additional approval here, on the execution device.</Note>
          <div className="mt-2 flex justify-end gap-2.5">
            <Action action="close-task" label="Cancel" />
            <Button type="submit">Save permissions</Button>
          </div>
        </form>
      </Section>
    </>
  );
}

export function CommandPanel({ host }: { host: string }) {
  const items = [
    { label: `${ui.state.device.name} · this computer`, value: "" },
    ...ui.state.peers.map((p) => ({ label: p.name, value: p.id })),
  ];
  return (
    <>
      <PageHeading
        title={`Command: ${host}`}
        description="Choose where it runs and review the effect before anything changes."
      />
      <Section>
        <form id="command-form" key={host} className="grid gap-4">
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="command-peer" label="Run on" help="The machine the command runs on. Pick one from the list." />
            <Select name="peer" items={items} defaultValue={ui.commandPeer}>
              <SelectTrigger id="command-peer" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="command-program" label="Program" help="The program to run, for example uname. Only the program name, not the whole command line." />
            <Input id="command-program" name="program" defaultValue="uname" required />
          </div>
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="command-arguments" label="Arguments (one per line)" help="Each argument on its own line. For example, -s on its own line makes uname -s." />
            <Textarea id="command-arguments" name="arguments" defaultValue="-s" />
            <Note>Each line is passed as one argument. Homectl does not run a shell.</Note>
          </div>
          <div className="grid gap-1.5">
            <HelpLabel htmlFor="command-impact" label="What should this do?" help="A plain description for whoever approves the request, for example: Read the system name." />
            <Input
              id="command-impact"
              name="impact"
              defaultValue="Inspect the operating system"
              required
            />
          </div>
          <Note>
            The other device must grant access to this host. Changes also need approval
            there.
          </Note>
          <div className="mt-2 flex justify-end gap-2.5">
            <Action action="close-task" label="Cancel" />
            <Button type="submit">Review command</Button>
          </div>
        </form>
      </Section>
      <Output />
    </>
  );
}

