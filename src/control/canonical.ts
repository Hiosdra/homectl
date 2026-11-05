import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Sorted-key JSON with undefined properties dropped. Fingerprints and the
// audit chain hash this form so logically equal records always hash equally.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = normalize(item);
    }
    return out;
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}
