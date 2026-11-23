// The owner's setup routes as the broker's SetupPort. Each approved request calls
// the same owner route the panel uses, with the password step-up already settled
// by the approval (decide checks it before dispatch). Results and failures are
// returned as plain sentences: no address, key or probe text reaches the agent.
import { HomectlError, type ProcessResult } from "../types";
import type { ScanRecords } from "./scan-records";
import { describeApprovalWait } from "./approval-wait";
import { APPROVAL_WAIT_PATH } from "./settings-routes";
import type { PresentedKey, SetupPort, SetupRun } from "./types";

export type OwnerCall = (
  path: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface SetupExecDeps {
  // The owner-hosts routes (scan, probe, enroll, access, remove, key-status).
  hosts: OwnerCall;
  // The policy routes (preset).
  policy: OwnerCall;
  // The scans the owner's scan route recorded. Read only: planning uses it.
  scans: ScanRecords;
  // The owner's settings routes (approval-wait).
  settings: OwnerCall;
}

const PRESET_LABEL: Record<string, string> = {
  conservative: "Ask me first",
  routine: "AI helps with small fixes",
  delegated: "AI decides more",
};

const KEYS_CHANGED =
  "The machine now shows a different key from the one on the card. Nothing was added. Ask for a new scan.";

interface ScanReply {
  keys?: { type: string; fingerprint: string }[];
}

// The text an agent may see for a failure: the message, with the requested
// address taken out. Other failures get one generic sentence.
function plainFailure(error: unknown, address: string | undefined): string {
  const text =
    error instanceof HomectlError
      ? error.message
      : "The change did not finish. The owner can see why in Details.";
  return address ? text.split(address).join("that address") : text;
}

function summary(
  kind: SetupRun["kind"],
  input: Record<string, unknown>,
  reply: unknown,
): string {
  const value = (reply ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "scan": {
      const keys = (reply as ScanReply).keys ?? [];
      return `Found ${keys.length} host key(s) at the address. Nothing was added or trusted.`;
    }
    case "probe":
      return value.ok === true
        ? "The machine answered the check."
        : "The machine did not answer the check. The owner can see why in Details.";
    case "enroll":
      return `Added the machine with ${String(value.access ?? input.access)} access.`;
    case "access":
      return `${String(input.name)} now has ${String(input.access)} access.`;
    case "remove":
      return "Removed the machine from homectl.";
    case "preset":
      return `The AI permission setting is now ${PRESET_LABEL[String(input.preset)] ?? String(input.preset)}.`;
    case "approval-wait":
      return `Requests now wait for you up to ${describeApprovalWait(Number(input.waitMs))}.`;
  }
}

export function ownerSetupPort(deps: SetupExecDeps): SetupPort {
  const keyStatus = async (name: string) =>
    (await deps.hosts("/v1/owner/hosts/key-status", { name })) as {
      present?: boolean;
    };
  return {
    async lastScan(address, port) {
      return deps.scans.last(address, port);
    },
    async keyReady(name) {
      return (await keyStatus(name)).present === true;
    },
    async run(request): Promise<ProcessResult> {
      const { kind, input } = request;
      const address =
        typeof input.address === "string" ? input.address : undefined;
      try {
        const reply = await execute(deps, request);
        return {
          exitCode: 0,
          stdout: summary(kind, input, reply),
          stderr: "",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: plainFailure(error, address),
        };
      }
    },
  };
}

// Enrolment reads the machine's keys again. They must be exactly the keys the card
// showed (the recorded scan) and include the one the owner typed; otherwise the
// owner's confirmation no longer describes this machine, and nothing is added.
async function keysUnchanged(
  deps: SetupExecDeps,
  request: SetupRun,
  typed: string,
): Promise<void> {
  const recorded = (request.presented ?? [])
    .map((key: PresentedKey) => key.fingerprint)
    .sort();
  if (recorded.length === 0 || !recorded.includes(typed))
    throw new HomectlError(3, KEYS_CHANGED);
  const reply = (await deps.hosts("/v1/owner/hosts/scan", {
    address: request.input.address,
    port: request.input.port ?? 22,
  })) as ScanReply;
  const now = (reply.keys ?? []).map((key) => key.fingerprint).sort();
  if (
    now.length !== recorded.length ||
    now.some((fingerprint, index) => fingerprint !== recorded[index])
  )
    throw new HomectlError(3, KEYS_CHANGED);
}

// One approved request, through one owner route. Enrolment passes the fingerprint
// the owner typed; the route checks it against a fresh scan before it pins anything.
async function execute(
  deps: SetupExecDeps,
  request: SetupRun,
): Promise<unknown> {
  const { kind, input } = request;
  switch (kind) {
    case "scan":
      return deps.hosts("/v1/owner/hosts/scan", {
        address: input.address,
        port: input.port ?? 22,
      });
    case "probe":
      return deps.hosts("/v1/owner/hosts/probe", { name: input.name });
    case "enroll": {
      const typed = request.confirmFingerprint;
      if (typed === undefined)
        throw new HomectlError(
          3,
          "The owner has not confirmed the machine's fingerprint",
        );
      await keysUnchanged(deps, request, typed);
      return deps.hosts("/v1/owner/hosts/enroll", {
        ...input,
        fingerprint: typed,
      });
    }
    case "access":
      return deps.hosts("/v1/owner/hosts/access", {
        name: input.name,
        access: input.access,
      });
    case "remove":
      return deps.hosts("/v1/owner/hosts/remove", { name: input.name });
    case "preset":
      return deps.policy("/v1/owner/policy/preset", { preset: input.preset });
    case "approval-wait":
      return deps.settings(APPROVAL_WAIT_PATH, { waitMs: input.waitMs });
  }
}
