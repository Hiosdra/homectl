// Browser side of homectl self-update (homelab #21 §8). The broker has no update
// route yet: when the status route answers 404 the panel shows status only and
// offers no Update button. Whatever the broker returns is checked here before
// the UI uses it; the panel never runs or downloads anything itself.
import { OwnerApiError, ownerCall } from "./api";

export type SignatureState = "verified" | "failed" | "unverified" | "unknown";

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  signature: SignatureState;
  // True when the broker can apply the offered version from this panel.
  canApply: boolean;
  // Why the broker cannot apply it here (a container, a source checkout, a
  // package manager, an unsupported platform). Shown only when canApply is false.
  reason?: string;
}

const SIGNATURES: readonly SignatureState[] = [
  "verified",
  "failed",
  "unverified",
  "unknown",
];

// Major.minor.patch, or undefined when the text is not a version.
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// The one sentence about releases on the System screen, in plain words. A build
// newer than the latest release is said so, rather than printed beside it as if
// the two numbers were in conflict.
export function releaseSentence(status: UpdateStatus): string {
  const { current, latest, available } = status;
  if (latest === undefined) return "Could not check for a newer release.";
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (available) return `Version ${latest} is available.`;
  if (a === undefined || b === undefined)
    return `The latest release is ${latest}.`;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return (a[i] ?? 0) > (b[i] ?? 0)
        ? `You have ${current}, a test version newer than the latest release (${latest}).`
        : `You are up to date. The latest release is ${latest}.`;
    }
  }
  return `You are up to date. The latest release is ${latest}.`;
}

// Accepts only the documented shape; anything else is treated as "no status".
export function toUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.current !== "string" || raw.current.length > 64)
    return undefined;
  const latest =
    typeof raw.latest === "string" && raw.latest.length <= 64
      ? raw.latest
      : undefined;
  const signature = SIGNATURES.find((item) => item === raw.signature);
  const canApply = raw.canApply === true;
  // Broker text, shown as plain text. Bounded so a bad broker cannot flood the page.
  const reason =
    !canApply && typeof raw.reason === "string" && raw.reason.length <= 400
      ? raw.reason
      : undefined;
  return {
    current: raw.current,
    ...(latest === undefined ? {} : { latest }),
    available: raw.available === true && latest !== undefined,
    signature: signature ?? "unknown",
    canApply,
    ...(reason === undefined ? {} : { reason }),
  };
}

// undefined when the broker has no update route (404) or sends an unreadable
// status; other failures throw.
export async function readUpdateStatus(): Promise<UpdateStatus | undefined> {
  try {
    return toUpdateStatus(await ownerCall<unknown>("/v1/owner/update/status"));
  } catch (error) {
    if (error instanceof OwnerApiError && error.status === 404)
      return undefined;
    throw error;
  }
}

// The owner confirms one exact version. The broker must verify the signature
// and refuse anything other than the version it offered.
export function applyUpdate(
  version: string,
  password: string,
): Promise<{ state: string; next?: string }> {
  return ownerCall<{ state: string; next?: string }>("/v1/owner/update/apply", {
    version,
    password,
  });
}

export function signatureLabel(state: SignatureState): {
  text: string;
  tone: "good" | "warn" | "bad" | "neutral";
} {
  switch (state) {
    case "verified":
      return { text: "Signature verified", tone: "good" };
    case "failed":
      return { text: "Signature check failed", tone: "bad" };
    case "unverified":
      return { text: "Signature not verified", tone: "warn" };
    case "unknown":
      return { text: "Signature status unknown", tone: "neutral" };
  }
}
