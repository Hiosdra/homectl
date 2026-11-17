import { redactArgv } from "./redact";
import type { AuditEvent } from "./types";

type RejectionContext = Pick<
  AuditEvent,
  "host" | "argv" | "operationId" | "policyDecision" | "reason"
>;

export function rejectedRequestContext(
  raw: unknown,
  code: number,
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
  const argv =
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
      ? redactArgv(request.argv as string[])
      : undefined;
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
    policyDecision: code === 4 ? "needs-approval" : "refused",
    reason:
      code === 4
        ? "approval-required"
        : code === 3
          ? "policy-refused"
          : "request-rejected",
  };
}
