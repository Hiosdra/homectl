// Secret redaction for full-mode Proxmox output and parameters. Names and
// patterns come from the control plane's secret rules, so both layers agree.
import { containsSecretMaterial, isSecretOptionName } from "../control/redact";

export const REDACTED = "[REDACTED]";

// Walks an API response: any value under a secret-looking key, and any string
// that looks like secret material, is replaced before it leaves homectl.
export function redactOutput(value: unknown): unknown {
  if (typeof value === "string")
    return containsSecretMaterial(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactOutput);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = isSecretOptionName(key) ? REDACTED : redactOutput(item);
    return out;
  }
  return value;
}

// Parameters as shown in approvals and views. Plans refuse secret-named
// parameters, so this only guards against a stored plan written by an older rule.
export function redactParams(
  params: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params))
    out[key] = isSecretOptionName(key) ? REDACTED : value;
  return out;
}
