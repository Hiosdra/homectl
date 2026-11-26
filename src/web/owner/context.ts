// Device context of the owner panel (homelab #21 §8): which devices the views
// show. "All devices" is everything, "This device" is this broker's own queue,
// and a linked client is one client's rows. The choice is a view filter only:
// approve and deny still send the client id and operation id they always did,
// so no decision changes meaning. The choice is remembered per viewer in
// localStorage, never in the URL and never with a token.
export type DeviceContext =
  { kind: "all" } | { kind: "local" } | { kind: "client"; id: string };

// What a filtered view says about the context it shows: its label, and how
// many waiting items on other devices the context hides.
export interface ViewScope {
  context: DeviceContext;
  label: string;
  hidden: number;
}

export const ALL_DEVICES: DeviceContext = { kind: "all" };
export const THIS_DEVICE: DeviceContext = { kind: "local" };
export const CONTEXT_STORAGE_KEY = "homectl.owner.context";

const CLIENT_PREFIX = "client:";
const MAX_CLIENT_ID = 64;

export function encodeContext(context: DeviceContext): string {
  return context.kind === "client"
    ? `${CLIENT_PREFIX}${context.id}`
    : context.kind;
}

// Anything unknown, including a value from another panel version, means All
// devices: a stale preference must never hide the whole inbox.
export function parseContext(value: string | null | undefined): DeviceContext {
  if (value === "local") return THIS_DEVICE;
  if (value?.startsWith(CLIENT_PREFIX)) {
    const id = value.slice(CLIENT_PREFIX.length);
    if (id.length > 0 && id.length <= MAX_CLIENT_ID)
      return { kind: "client", id };
  }
  return ALL_DEVICES;
}

// localStorage can be missing, blocked or throwing (private windows, cleared
// site data). Every access is wrapped: the panel works without it.
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadContext(): DeviceContext {
  try {
    return parseContext(storage()?.getItem(CONTEXT_STORAGE_KEY));
  } catch {
    return ALL_DEVICES;
  }
}

export function saveContext(context: DeviceContext): void {
  try {
    storage()?.setItem(CONTEXT_STORAGE_KEY, encodeContext(context));
  } catch {
    // Not remembered for later visits; the choice still applies now.
  }
}

// A client that is no longer linked falls back to All devices. Before the
// client list has loaded the choice is kept as it is.
export function resolveContext(
  context: DeviceContext,
  clients: readonly { id: string }[] | undefined,
): DeviceContext {
  if (context.kind !== "client" || clients === undefined) return context;
  return clients.some((client) => client.id === context.id)
    ? context
    : ALL_DEVICES;
}

// Rows of one origin. `clientOf` names the linked client a row belongs to.
// This device has no linked-client rows, so it keeps none of them.
export function scopeRows<T>(
  context: DeviceContext,
  rows: readonly T[],
  clientOf: (row: T) => string,
): T[] {
  switch (context.kind) {
    case "all":
      return [...rows];
    case "local":
      return [];
    case "client":
      return rows.filter((row) => clientOf(row) === context.id);
  }
}

export function sameContext(a: DeviceContext, b: DeviceContext): boolean {
  return encodeContext(a) === encodeContext(b);
}

// Local approvals and secret requests belong to This device only.
export function showsLocal(context: DeviceContext): boolean {
  return context.kind !== "client";
}

export function contextLabel(
  context: DeviceContext,
  clients: readonly { id: string; name: string }[],
): string {
  switch (context.kind) {
    case "all":
      return "All devices";
    case "local":
      return "This device";
    case "client":
      return (
        clients.find((client) => client.id === context.id)?.name ??
        "Linked client"
      );
  }
}

export function viewScope(
  context: DeviceContext,
  clients: readonly { id: string; name: string }[],
  hidden: number,
): ViewScope {
  return { context, label: contextLabel(context, clients), hidden };
}
