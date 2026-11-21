// Full-mode Proxmox operations (inventory operations: "full"). Pure validation and
// classification: a request becomes one route row, one exact API path and a
// parameter map, or it is refused. Nothing here contacts a host.
import { containsSecretMaterial, isSecretOptionName } from "../control/redact";
import { HomectlError } from "../types";
import type { ApiRequest } from "./api";
import type { ProxmoxFacts } from "./catalogue";
import type { FullMethod, FullRoute } from "./full-route-types";
import { FULL_ROUTES } from "./full-routes";
import type { Risk } from "../core/contracts";

export type FullClassification = "inspect" | "mutation" | "destructive";

export interface FullInput {
  method: FullMethod;
  path: string;
  params?: Record<string, string>;
}

export interface FullOperation {
  method: FullMethod;
  path: string; // normalised: leading slash, no trailing slash
  params: Record<string, string>;
  route: FullRoute;
  risk: Risk;
  ownerOnly: boolean;
  classification: FullClassification;
  label: string; // plain language, shown on the approval
  vmid?: number;
}

const METHODS: readonly FullMethod[] = ["GET", "POST", "PUT", "DELETE"];
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,127}$/;
// A storage volume id such as local:backup/name, sent with its slash encoded.
const VOLUME_SEGMENT =
  /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,127}(?:%2F[A-Za-z0-9._:+@-]{1,127})+$/;
const VMID = /^[1-9][0-9]{2,8}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_PATH = 300;
const MAX_PARAMS = 64;
// Parameters that name a guest id, and that must stay inside vmid_range.
const VMID_PARAMS = ["vmid", "newid"];
// Parameters that name a storage, checked against the provider's allowlist.
const STORAGE_PARAMS = ["storage", "target-storage"];
// Parameters that bypass a Proxmox safety check, so they are never accepted.
const REFUSED_PARAMS = ["force", "skiplock"];

function refuse(code: 2 | 3, message: string): never {
  throw new HomectlError(code, message);
}

// Up to 1024 characters, none of them control characters (code points below
// 32, and DEL).
function plainText(value: string): boolean {
  if (value.length > 1024) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function checkPath(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 2 ||
    raw.length > MAX_PATH ||
    !raw.startsWith("/") ||
    raw.endsWith("/")
  )
    refuse(
      2,
      "Path must start with / and must not end with a slash, for example /nodes/<node>/qemu",
    );
  if (raw.includes("..") || /[?#\\%]/.test(raw.replace(/%2F/g, "")))
    refuse(2, "Path contains characters that are not allowed");
  for (const segment of raw.slice(1).split("/"))
    if (!SEGMENT.test(segment) && !VOLUME_SEGMENT.test(segment))
      refuse(2, "Path segments may use letters, digits and . _ : + @ -");
  return raw;
}

function partFits(part: string, value: string, facts: ProxmoxFacts): boolean {
  switch (part) {
    case "{node}":
      return value === facts.node;
    case "{type}":
      return value === "qemu" || value === "lxc";
    case "{vmid}":
      return VMID.test(value);
    case "{id}":
      return SEGMENT.test(value);
    case "{volume}":
      return SEGMENT.test(value) || VOLUME_SEGMENT.test(value);
    default:
      return part === value;
  }
}

// A template fits when every fixed part matches. A trailing "**" accepts any
// number of further plain name segments.
function fits(template: string, segments: string[], facts: ProxmoxFacts) {
  const parts = template.split("/");
  const wildcard = parts[parts.length - 1] === "**";
  const fixed = wildcard ? parts.slice(0, -1) : parts;
  if (
    wildcard ? segments.length < fixed.length : segments.length !== fixed.length
  )
    return false;
  return (
    fixed.every((part, i) => partFits(part, segments[i] ?? "", facts)) &&
    segments.slice(fixed.length).every((segment) => SEGMENT.test(segment))
  );
}

function checkParams(raw: Record<string, string>): Record<string, string> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_PARAMS)
    refuse(2, `A request takes at most ${MAX_PARAMS} parameters`);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!PARAM_NAME.test(key))
      refuse(2, "Parameter names may use letters, digits and . _ -");
    if (REFUSED_PARAMS.includes(key))
      refuse(
        3,
        `Parameter ${key} is not accepted: it bypasses homectl's checks`,
      );
    if (typeof value !== "string" || !plainText(value))
      refuse(
        2,
        `Parameter ${key} must be text of up to 1024 characters without control characters`,
      );
    if (isSecretOptionName(key) || containsSecretMaterial(`${key}=${value}`))
      refuse(
        3,
        `Parameter ${key} looks like a secret. Secret values are not accepted in homectl plans; set them in the Proxmox interface`,
      );
    out[key] = value;
  }
  return out;
}

// Any change to a guest needs an explicit vmid_range in the inventory.
function guestChange(method: FullMethod, facts: ProxmoxFacts): void {
  if (method !== "GET" && !facts.vmidRangeSet)
    refuse(
      3,
      `Set vmid_range for ${facts.host} in the inventory before changing guests`,
    );
}

function guestId(value: string, facts: ProxmoxFacts, label: string): number {
  if (!VMID.test(value)) refuse(2, `${label} must be a guest id`);
  const id = Number(value);
  if (id < facts.vmidMin || id > facts.vmidMax)
    refuse(
      3,
      `${label} ${id} is outside the provider's vmid_range (${facts.vmidMin} to ${facts.vmidMax})`,
    );
  return id;
}

function checkGuests(
  template: string,
  segments: string[],
  method: FullMethod,
  params: Record<string, string>,
  facts: ProxmoxFacts,
): number | undefined {
  const index = template.split("/").indexOf("{vmid}");
  let vmid: number | undefined;
  if (index !== -1) {
    vmid = guestId(segments[index] ?? "", facts, "VMID");
    guestChange(method, facts);
    if (
      facts.protectedVmids.includes(vmid) &&
      (method === "DELETE" || template.endsWith("/rollback"))
    )
      refuse(
        3,
        `VM ${vmid} is listed in protected_vmids and cannot be destroyed or rolled back`,
      );
  }
  for (const key of VMID_PARAMS) {
    const value = params[key];
    if (value === undefined) continue;
    const id = guestId(value, facts, `Parameter ${key}`);
    guestChange(method, facts);
    if (facts.protectedVmids.includes(id))
      refuse(
        3,
        `VM ${id} is listed in protected_vmids and cannot be used as a target`,
      );
  }
  // Creating or cloning without an explicit id would let Proxmox pick one
  // outside vmid_range, so both must name the id.
  if (
    method === "POST" &&
    template === "nodes/{node}/{type}" &&
    params.vmid === undefined
  )
    refuse(
      3,
      "Creating or restoring a guest needs an explicit vmid inside vmid_range",
    );
  if (
    method === "POST" &&
    template.endsWith("/clone") &&
    params.newid === undefined
  )
    refuse(3, "Cloning needs an explicit newid inside vmid_range");
  return vmid;
}

function checkStorage(
  segments: string[],
  params: Record<string, string>,
  facts: ProxmoxFacts,
): void {
  const used: string[] = [];
  const at = segments.indexOf("storage");
  if (at !== -1 && segments[at + 1] !== undefined)
    used.push(segments[at + 1] ?? "");
  for (const key of STORAGE_PARAMS) {
    const value = params[key];
    if (value !== undefined) used.push(value);
  }
  if (used.length === 0) return;
  if (facts.storages.length === 0)
    refuse(
      3,
      "Set storages for this provider in the inventory before using storage operations",
    );
  for (const name of used)
    if (!facts.storages.includes(name))
      refuse(3, "Storage is not allowed for this Proxmox provider");
}

// Validates one request and returns the exact route, path and parameters it
// would send. Throws a HomectlError (code 2 for malformed input, 3 for refusals).
export function fullOperation(
  input: FullInput,
  facts: ProxmoxFacts,
): FullOperation {
  if (!METHODS.includes(input.method))
    refuse(2, "Method must be GET, POST, PUT or DELETE");
  const path = checkPath(input.path);
  const segments = path.slice(1).split("/");
  if (
    segments[0] === "nodes" &&
    segments[1] !== undefined &&
    segments[1] !== facts.node
  )
    refuse(3, "Only the provider's node can be named in a path");
  const route = FULL_ROUTES.find(
    (row) => row.method === input.method && fits(row.template, segments, facts),
  );
  if (route === undefined)
    refuse(
      3,
      "This Proxmox operation is not in homectl's full-mode catalogue, so it is refused",
    );
  const params = checkParams(input.params ?? {});
  const vmid = checkGuests(
    route.template,
    segments,
    input.method,
    params,
    facts,
  );
  checkStorage(segments, params, facts);
  const type = segments.find((part) => part === "qemu" || part === "lxc");
  const guest =
    vmid === undefined
      ? "guest"
      : `${type === "lxc" ? "container" : "VM"} ${vmid}`;
  const risk = route.risk;
  return {
    method: input.method,
    path,
    params,
    route,
    risk,
    ownerOnly: route.ownerOnly,
    classification:
      risk === "R1" ? "inspect" : risk === "R4" ? "destructive" : "mutation",
    label: route.label
      .replaceAll("{guest}", guest)
      .replaceAll("{node}", facts.node),
    ...(vmid === undefined ? {} : { vmid }),
  };
}

// The API request for a validated operation. Output is redacted for every
// full-mode call, so secrets in a response never reach the caller.
export function fullApiRequest(
  op: Pick<FullOperation, "method" | "path" | "params">,
): ApiRequest {
  return {
    method: op.method,
    path: op.path,
    params: { ...op.params },
    task: op.method !== "GET",
    inspect: op.method === "GET",
    redact: true,
  };
}
