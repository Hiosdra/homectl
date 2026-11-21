// One-time launch codes for `home-ctl panel` (audit 3.3). The launch token used
// to travel in the browser address as a fragment, where it reaches history and
// screenshots. Now the CLI trades the token for a short-lived code with a POST
// (checked against the panel's Origin like /api/connect), and the browser opens
// /launch?code=…. That answers with the panel cookie and a redirect to /, so the
// code is spent on first use and the token never appears in any URL.
import { randomBytes } from "node:crypto";
import { HomectlError } from "../types";

export const LAUNCH_CODE_MS = 2 * 60_000;

export class LaunchCodes {
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = LAUNCH_CODE_MS,
  ) {}

  // A fresh code. Expired codes are dropped on the way.
  issue(): { code: string; expiresInSeconds: number } {
    const at = this.now();
    for (const [code, expires] of this.codes)
      if (expires <= at) this.codes.delete(code);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, at + this.ttlMs);
    return { code, expiresInSeconds: Math.round(this.ttlMs / 1000) };
  }

  // True once for a live code: the code is removed whether or not it was valid.
  redeem(code: string | null): boolean {
    if (!code) return false;
    const expires = this.codes.get(code);
    this.codes.delete(code);
    return expires !== undefined && expires > this.now();
  }
}

// The CLI side: exchanges the launch token (from panel.json, on this computer)
// for a code. Throws a plain sentence when the panel does not answer.
export async function requestLaunchCode(launch: {
  url: string;
  token: string;
}): Promise<string> {
  const response = await fetch(`${launch.url}/api/launch`, {
    method: "POST",
    headers: {
      origin: launch.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: launch.token }),
  }).catch(() => undefined);
  const body = (await response?.json().catch(() => undefined)) as
    { code?: unknown } | undefined;
  if (!response?.ok || typeof body?.code !== "string")
    throw new HomectlError(
      5,
      "The local panel did not accept this launch. Stop the old workspace in its terminal, then run home-ctl panel again.",
    );
  return body.code;
}
