// Proxmox requests in Needs you. The title says what will happen in plain words
// (for example "Reboot VM 105 on pve"); the method, path and parameters sit under
// Details, as the exact request. Nothing here is inline-styled: the panel's CSP
// forbids inline styles.
import type { PendingOperation } from "./api";
import { sentenceCase } from "./plain-words";

export interface ProxmoxRequest {
  api?: { method: string; path: string; params?: Record<string, string> };
  catalogue?: { kind: string; action: string; vmid?: number; name?: string };
}

const SECRET_LOOKING = /pass|token|secret|key|cipassword|auth/i;

// The label a person reads. The broker sends the route's own label as impact.
export function proxmoxTitle(operation: PendingOperation): string {
  const label = operation.impact?.trim() || "Make a Proxmox change";
  return `${sentenceCase(label)} on ${operation.host}?`;
}

export function isProxmoxOperation(operation: PendingOperation): boolean {
  return operation.proxmox !== undefined;
}

// Parameter rows for Details. Values under secret-looking names are hidden; the
// broker already refuses such parameters, so this only guards the display.
export function proxmoxParamRows(
  params: Record<string, string> | undefined,
): [string, string][] {
  return Object.entries(params ?? {}).map(([key, value]) => [
    key,
    SECRET_LOOKING.test(key) ? "[hidden]" : value,
  ]);
}

// The request as text, for Details and tests.
export function proxmoxRequestLine(request: ProxmoxRequest): string {
  if (request.api) return `${request.api.method} ${request.api.path}`;
  const catalogue = request.catalogue;
  return catalogue
    ? `${catalogue.action} ${catalogue.kind}${catalogue.vmid === undefined ? "" : ` ${catalogue.vmid}`}`
    : "";
}

// Rows for the Details list. They are <dt>/<dd> pairs, placed inside the
// approval's existing <dl>.
export function ProxmoxDetailRows({
  operation,
}: {
  operation: PendingOperation;
}) {
  const request = operation.proxmox as ProxmoxRequest | undefined;
  if (request === undefined) return null;
  const params = proxmoxParamRows(request.api?.params);
  return (
    <>
      <dt>Area</dt>
      <dd>{operation.area ?? "Proxmox"}</dd>
      <dt>Request</dt>
      <dd>
        <span className="mono">{proxmoxRequestLine(request)}</span>
      </dd>
      {params.length > 0 ? (
        <>
          <dt>Parameters</dt>
          <dd>
            {params.map(([key, value]) => (
              <span className="chip" key={key}>
                {key}={value}
              </span>
            ))}
          </dd>
        </>
      ) : null}
    </>
  );
}

// Shown under the title for owner-only changes.
export function OwnerOnlyNote({ operation }: { operation: PendingOperation }) {
  if (operation.ownerOnly !== true) return null;
  return (
    <p className="small">
      <strong>Only you can approve this.</strong> No assistant, rule or other
      client can approve it, and it needs your owner password.
    </p>
  );
}
