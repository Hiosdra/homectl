import { useEffect, useState } from "react";
import { api, report, ui } from "../store";
import type { SavedCommand, SavedCommandListItem } from "../types";
import { Action, ListRow, Note, PageHeading, Section, Tag } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Output } from "./output";

function CommandEditor() {
  const draft = ui.savedCommandDraft;
  if (!draft) return null;
  return (
    <Section title={draft.id ? "Edit saved command" : "New saved command"}>
      <form id="saved-command-form" className="grid gap-4">
        {draft.id ? <input type="hidden" name="id" value={draft.id} /> : null}
        <div className="grid gap-1.5">
          <Label htmlFor="saved-name">Name</Label>
          <Input id="saved-name" name="name" defaultValue={draft.name} maxLength={80} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="saved-hosts">Target hosts</Label>
          <Input id="saved-hosts" name="hosts" defaultValue={draft.hosts.join(", ")} placeholder="nas, voron" required />
          <Note>Comma separated host names. A host missing from this device remains unavailable until its inventory includes it.</Note>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="saved-argv">Arguments (JSON array)</Label>
          <Textarea id="saved-argv" name="argv" defaultValue={JSON.stringify(draft.argv, null, 2)} required />
          <Note>Each array item is one argv value. Newlines inside an item are preserved; values are never shell input.</Note>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="saved-parameters">Declared parameters (one per line)</Label>
          <Textarea id="saved-parameters" name="parameters" defaultValue={draft.parameters.map((p) => `${p.name}${p.description ? ` | ${p.description}` : ""}`).join("\n")} placeholder="unit | systemd service name" />
          <Note>Reference a parameter as <code>{"{{name}}"}</code> inside one argv item. Values are requested for each run and never saved.</Note>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="saved-description">Description (optional)</Label>
          <Textarea id="saved-description" name="description" defaultValue={draft.description ?? ""} maxLength={500} />
        </div>
        <div className="flex justify-end gap-2.5">
          <Action action="saved-command-cancel-edit" label="Cancel" />
          <Button type="submit">Save command</Button>
        </div>
      </form>
    </Section>
  );
}

function RunCommand({ command }: { command: SavedCommand }) {
  const available = command.available;
  return (
    <Section title={`Run ${command.name}`}>
      <p className="mb-4 text-sm text-muted-foreground">This is only a shortcut. Homectl checks the current host inventory and policy again for every run; non-inspection commands need approval.</p>
      {command.unavailable.length ? <Note>Unavailable here: {command.unavailable.join(", ")}</Note> : null}
      {!available.length ? <p className="mt-3 text-sm text-warning">Add one of the saved hosts to this device's inventory before running this command.</p> : (
        <form id="saved-command-run-form" className="grid gap-4">
          <input type="hidden" name="id" value={command.id} />
          <div className="grid gap-1.5">
            <Label htmlFor="saved-run-host">Target host</Label>
            <select id="saved-run-host" name="host" defaultValue={available[0]} className="h-10 rounded-md border border-input bg-background px-3">
              {available.map((host) => <option key={host} value={host}>{host}</option>)}
            </select>
          </div>
          {command.parameters.map((parameter) => (
            <div className="grid gap-1.5" key={parameter.name}>
              <Label htmlFor={`saved-param-${parameter.name}`}>{parameter.name}</Label>
              <Input id={`saved-param-${parameter.name}`} name={`parameter-${parameter.name}`} required maxLength={4096} />
              {parameter.description ? <Note>{parameter.description}</Note> : null}
            </div>
          ))}
          <div className="flex justify-end gap-2.5">
            <Action action="saved-command-cancel-run" label="Back to commands" />
            <Button type="submit">Review and run</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

export function CommandsScreen() {
  const [commands, setCommands] = useState<SavedCommandListItem[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    void api<{ commands: SavedCommandListItem[] }>("/api/commands")
      .then((result) => setCommands(result.commands))
      .catch((error) => report(String(error)))
      .finally(() => setLoading(false));
  }, [ui.savedCommandVersion]);
  const validCommands = commands.filter(
    (command): command is SavedCommand => !("status" in command),
  );
  const invalidCommands = commands.filter(
    (command): command is Extract<SavedCommandListItem, { status: "invalid" }> =>
      "status" in command,
  );
  const selected = validCommands.find((command) => command.id === ui.savedCommandRun);
  return (
    <>
      <PageHeading
        title="Saved commands"
        description="Local command templates that sync through the reviewed peer comparison. Templates never carry access grants, approvals or saved parameter values."
        actions={<Action action="saved-command-new" label="New command" />}
      />
      <CommandEditor />
      {selected ? <div className="mt-5"><RunCommand command={selected} /></div> : null}
      <Section title="Your command templates" className={ui.savedCommandDraft || selected ? "mt-5" : ""}>
        {loading ? <p role="status" className="text-sm text-muted-foreground">Loading saved commands…</p> : null}
        {!loading && !commands.length ? <p className="text-sm text-muted-foreground">No saved commands yet. Save one from an audit entry or create a template here.</p> : null}
        {validCommands.map((command) => (
          <ListRow key={command.id} actions={
            <div className="flex flex-wrap gap-2">
              <Action action="saved-command-run" id={command.id} label="Run" />
              <Action action="saved-command-edit" id={command.id} label="Edit" />
              <Action action="saved-command-remove" id={command.id} label="Remove" kind="quiet-danger" />
            </div>
          }>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><strong>{command.name}</strong><Tag>{command.available.length ? `Available on ${command.available.join(", ")}` : "Unavailable here"}</Tag></div>
              <p className="mt-1 break-all text-sm text-muted-foreground"><code>{JSON.stringify(command.argv)}</code></p>
              {command.description ? <p className="mt-1 text-sm text-muted-foreground">{command.description}</p> : null}
              {command.unavailable.length ? <p className="mt-1 text-xs text-warning">Missing hosts: {command.unavailable.join(", ")}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">ID {command.id}</p>
            </div>
          </ListRow>
        ))}
        {invalidCommands.map((command) => (
          <ListRow key={command.id} actions={<Tag tone="warning">invalid — needs attention</Tag>}>
            <div className="min-w-0">
              <strong>Invalid saved command</strong>
              <p className="mt-1 break-all text-sm text-muted-foreground">ID {command.id}</p>
              <p className="mt-1 text-xs text-warning">{command.reason}</p>
            </div>
          </ListRow>
        ))}
      </Section>
      <Output />
    </>
  );
}
