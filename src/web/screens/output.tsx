// Result of the last remote or local operation, shown under the current screen.
import { ui } from "../store";
import { Action, ListRow, Muted, Pre, Section } from "../shared";

type KeyCreationResult = { name: string; publicKey: string; next: string };

function isKeyCreationResult(value: unknown): value is KeyCreationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<KeyCreationResult>;
  return (
    typeof result.name === "string" &&
    typeof result.publicKey === "string" &&
    typeof result.next === "string"
  );
}

export function Output() {
  return (
    <>
      {ui.operationResult ? (
        <Section title="Waiting for peer approval" className="mt-8">
          <Muted>
            Open the execution device’s workspace, review the command, and
            approve it locally.
          </Muted>
          <div className="mt-4">
            <Action action="operation-status" label="Check result" />
          </div>
        </Section>
      ) : null}
      {ui.remoteHosts ? (
        <Section title="Hosts on the paired device" className="mt-8">
          {ui.remoteHosts.hosts.map((h) => (
            <ListRow
              key={h.name}
              actions={
                <Action action="remote-command" label="Command" id={h.name} />
              }
            >
              <strong>{h.name}</strong>
              <p className="text-sm text-muted-foreground">
                {h.description} · {h.access}
              </p>
            </ListRow>
          ))}
        </Section>
      ) : null}
      {isKeyCreationResult(ui.result) ? (
        <Section
          title={`SSH key created for ${ui.result.name}`}
          className="mt-8"
        >
          <p className="mb-2 text-sm text-muted-foreground">
            Install this public key on the host through trusted access:
          </p>
          <code className="block break-all rounded-lg border border-border bg-background p-3 text-sm">
            {ui.result.publicKey}
          </code>
          <div className="mt-3">
            <Action action="key-copy-public" label="Copy public key" />
          </div>
          <Muted>{ui.result.next}</Muted>
        </Section>
      ) : ui.result !== undefined ? (
        <Section title="Operation result" className="mt-8">
          <Pre>
            {typeof ui.result === "string"
              ? ui.result
              : JSON.stringify(ui.result, null, 2)}
          </Pre>
        </Section>
      ) : null}
    </>
  );
}
