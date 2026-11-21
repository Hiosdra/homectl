// The one device-context switcher of the owner panel (homelab #21 §8), and the
// note every filtered view shows so the active context is never implicit. The
// switcher is a native select: keyboard, screen reader and phone pickers work
// without extra code. "Show all devices" is the one-click way back.
import { useId } from "react";
import {
  ALL_DEVICES,
  type DeviceContext,
  encodeContext,
  parseContext,
  type ViewScope,
} from "./context";
import { Notice } from "./ui";

export function ContextSwitcher({
  context,
  clients,
  onChange,
}: {
  context: DeviceContext;
  clients: readonly { id: string; name: string }[];
  onChange: (next: DeviceContext) => void;
}) {
  const id = useId();
  return (
    <div className="row context-switcher">
      <label htmlFor={id}>Devices</label>
      <select
        id={id}
        value={encodeContext(context)}
        onChange={(event) => onChange(parseContext(event.target.value))}
      >
        <option value={encodeContext(ALL_DEVICES)}>All devices</option>
        <option value={encodeContext({ kind: "local" })}>This device</option>
        {clients.map((client) => (
          <option
            key={client.id}
            value={encodeContext({ kind: "client", id: client.id })}
          >
            {client.name}
          </option>
        ))}
      </select>
      {context.kind === "all" ? null : (
        <button type="button" onClick={() => onChange(ALL_DEVICES)}>
          Show all devices
        </button>
      )}
    </div>
  );
}

// Names the context a filtered view shows. Renders nothing for All devices.
export function ContextNote({ scope }: { scope: ViewScope | undefined }) {
  if (!scope || scope.context.kind === "all") return null;
  const hidden =
    scope.hidden === 0
      ? ""
      : scope.hidden === 1
        ? " One item on other devices is hidden."
        : ` ${scope.hidden} items on other devices are hidden.`;
  return <Notice>{`Showing ${scope.label} only.${hidden}`}</Notice>;
}
