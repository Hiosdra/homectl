// Helpers for the panel's HTTP routes: request bodies, responses, and the checks on the
// local address and the presented secret.
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { HomectlError } from "../types";
import { security } from "./panel-headers";

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HomectlError(2, "JSON content type required");
  const text = await request.text();
  if (text.length > 24 * 1024 * 1024)
    throw new HomectlError(2, "Request too large");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new HomectlError(2, "JSON object required");
  return data;
}
// Constant-time comparison of a presented secret with the expected one.
export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
export function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: security });
}
export function isLoopbackInterface(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.toLowerCase();
  return normalized === "[::1]" || normalized.startsWith("[::ffff:");
}
export function failure(error: unknown) {
  const e =
    error instanceof HomectlError
      ? error
      : new HomectlError(
          2,
          "Invalid request or unavailable resource; details suppressed",
        );
  return response(
    { error: e.message, code: e.code },
    e.code === 3 ? 403 : e.code === 4 ? 409 : e.code === 5 ? 503 : 400,
  );
}
