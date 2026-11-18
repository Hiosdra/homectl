import { containsSecretMaterial, redactArgv } from "./redact";
import type { AuditEvent } from "./types";

type RejectionContext = Pick<
  AuditEvent,
  "host" | "argv" | "operationId" | "reason"
>;

export function rejectedRequestContext(
  raw: unknown,
  code: number,
  errorMessage?: string,
): RejectionContext {
  const request =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const host =
    typeof request.host === "string" &&
    /^[a-z][a-z0-9-]{0,62}$/.test(request.host)
      ? request.host
      : undefined;
  const rawArgv =
    Array.isArray(request.argv) &&
    request.argv.length > 0 &&
    request.argv.length <= 64 &&
    request.argv.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length > 0 &&
        arg.length <= 4096 &&
        !arg.includes("\0"),
    )
      ? (request.argv as string[])
      : undefined;
  const omitArgv =
    errorMessage?.startsWith("Secret-like material") === true ||
    (rawArgv !== undefined && containsSecretMaterial(rawArgv.join(" ")));
  const argv = rawArgv && !omitArgv ? redactArgv(rawArgv) : undefined;
  const operationId =
    typeof request.operationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      request.operationId,
    )
      ? request.operationId.toLowerCase()
      : undefined;

  return {
    ...(host ? { host } : {}),
    ...(argv ? { argv } : {}),
    ...(operationId ? { operationId } : {}),
    reason:
      code === 4
        ? "approval-required"
        : code === 3
          ? "policy-refused"
          : "request-rejected",
  };
}
