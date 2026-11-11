// Panel access gate for the vault-password unlock over plain HTTP (ADR-0003).
// The browser seals the password to this server's key with a one-time challenge.
// A successful unlock opens the vault session and issues the panel cookie. Idle
// time locks both again. Failed attempts count toward a short lockout.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { privateDirectory, protect } from "../platform";
import { HomectlError } from "../types";
import {
  fingerprint,
  fromHex,
  newServerKeys,
  openPassword,
  type SealedPassword,
  type ServerKeys,
  toHex,
} from "./unlock-seal";

export const PANEL_IDLE_MS = 2 * 60 * 60 * 1000;
const KEY_FILE = "unlock-key.json";
const HEX = /^(?:[0-9a-f]{2})+$/;
const MAX_CIPHERTEXT_HEX = 8192;
const CHALLENGE_LIMIT = 256;

export class GateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PanelGateOptions = {
  keys: ServerKeys;
  cookie: string;
  idleMs: number;
  onLock: () => void;
  now?: () => number;
  maxFailures?: number;
  lockoutMs?: number;
  challengeMs?: number;
};

export class PanelGate {
  readonly #keys: ServerKeys;
  readonly #cookie: string;
  readonly #idleMs: number;
  readonly #onLock: () => void;
  readonly #now: () => number;
  readonly #maxFailures: number;
  readonly #lockoutMs: number;
  readonly #challengeMs: number;
  readonly #challenges = new Map<string, number>();
  #failures = 0;
  #lockedUntil = 0;
  // The panel cookie (opened by a local access code or a vault unlock) and the vault
  // unlock are separate states. A local launch opens the panel without the vault.
  #panelOpen = false;
  #vaultOpen = false;
  #lastActive = 0;

  constructor(options: PanelGateOptions) {
    this.#keys = options.keys;
    this.#cookie = options.cookie;
    this.#idleMs = options.idleMs;
    this.#onLock = options.onLock;
    this.#now = options.now ?? Date.now;
    this.#maxFailures = options.maxFailures ?? 5;
    this.#lockoutMs = options.lockoutMs ?? 60_000;
    this.#challengeMs = options.challengeMs ?? 5 * 60_000;
  }

  keyInfo(): { pub: string; fingerprint: string } {
    return {
      pub: toHex(this.#keys.pub),
      fingerprint: fingerprint(this.#keys.pub),
    };
  }

  issueChallenge(): string {
    const now = this.#now();
    for (const [challenge, expires] of this.#challenges)
      if (expires <= now) this.#challenges.delete(challenge);
    if (this.#challenges.size >= CHALLENGE_LIMIT)
      throw new GateError(
        503,
        "Too many pending unlock requests. Try again shortly.",
      );
    const challenge = toHex(randomBytes(16));
    this.#challenges.set(challenge, now + this.#challengeMs);
    return challenge;
  }

  cookieHeader(): string {
    return `homectl=${this.#cookie}; HttpOnly; SameSite=Strict; Path=/`;
  }

  // True when the request carries the panel cookie and the panel is open and not idle.
  // A successful check counts as activity.
  authorize(cookieHeader: string | null): boolean {
    this.#expireIfIdle();
    if (!this.#panelOpen || !cookieHeader) return false;
    const expected = Buffer.from(`homectl=${this.#cookie}`);
    const matches = cookieHeader.split("; ").some((part) => {
      const candidate = Buffer.from(part);
      return (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      );
    });
    if (!matches) return false;
    this.#lastActive = this.#now();
    return true;
  }

  // Closes the panel and the vault, then tells the vault layer to lock.
  lock(): void {
    if (!this.#panelOpen && !this.#vaultOpen) return;
    this.#panelOpen = false;
    this.#vaultOpen = false;
    this.#onLock();
  }

  // A valid local access code opens the panel only. The vault stays locked.
  grantPanel(): string {
    this.#panelOpen = true;
    this.#lastActive = this.#now();
    return this.cookieHeader();
  }

  // Verify a sealed password and unlock. `open` checks the password against the vault
  // and throws if it is wrong. Every attempt that reaches the cryptography counts,
  // including attempts with an expired or unknown challenge.
  async unlock(
    input: unknown,
    open: (password: string) => Promise<void>,
  ): Promise<void> {
    const now = this.#now();
    if (now < this.#lockedUntil)
      throw new GateError(
        429,
        `Too many attempts. Try again in ${Math.ceil((this.#lockedUntil - now) / 1000)} s.`,
      );
    const envelope = parseEnvelope(input);
    const expires = this.#challenges.get(envelope.challenge);
    // One-time: the challenge is spent even if the attempt fails.
    this.#challenges.delete(envelope.challenge);
    if (expires === undefined || now > expires)
      return this.#fail(
        "Unlock request expired. Reload the page and try again.",
      );
    let password: string;
    try {
      password = openPassword(envelope, this.#keys);
    } catch {
      return this.#fail("Unlock failed. Check the vault password.");
    }
    try {
      await open(password);
    } catch {
      return this.#fail("Unlock failed. Check the vault password.");
    }
    this.#failures = 0;
    this.#vaultOpen = true;
    this.#panelOpen = true;
    this.#lastActive = this.#now();
  }

  #fail(message: string): never {
    this.#failures += 1;
    if (this.#failures >= this.#maxFailures) {
      this.#lockedUntil = this.#now() + this.#lockoutMs;
      this.#failures = 0;
    }
    throw new GateError(403, message);
  }

  #expireIfIdle(): void {
    if (this.#panelOpen && this.#now() - this.#lastActive >= this.#idleMs)
      this.lock();
  }
}

function parseEnvelope(input: unknown): SealedPassword {
  const v = input as Record<string, unknown> | null;
  const fields = ["eph", "nonce", "ct", "challenge"] as const;
  if (
    typeof v !== "object" ||
    v === null ||
    fields.some((f) => typeof v[f] !== "string")
  )
    throw new GateError(400, "Malformed unlock request");
  const envelope = {
    eph: v.eph as string,
    nonce: v.nonce as string,
    ct: v.ct as string,
    challenge: v.challenge as string,
  };
  if (
    !HEX.test(envelope.eph) ||
    !HEX.test(envelope.nonce) ||
    !HEX.test(envelope.ct) ||
    !HEX.test(envelope.challenge) ||
    envelope.ct.length > MAX_CIPHERTEXT_HEX
  )
    throw new GateError(400, "Malformed unlock request");
  return envelope;
}

// The server key is a private key for the unlock channel only. It is never the vault key.
export async function loadOrCreateServerKeys(
  directory: string,
): Promise<ServerKeys> {
  await privateDirectory(directory);
  const path = join(directory, KEY_FILE);
  const file = Bun.file(path);
  if (await file.exists()) {
    const stored = JSON.parse(await file.text()) as { secret?: unknown };
    if (typeof stored.secret !== "string")
      throw new HomectlError(3, "Panel unlock key file is invalid");
    const secret = fromHex(stored.secret, 32);
    return { secret, pub: x25519.getPublicKey(secret) };
  }
  const keys = newServerKeys();
  await Bun.write(path, `${JSON.stringify({ secret: toHex(keys.secret) })}\n`);
  await protect(path);
  return keys;
}

// Route handler for the unlock endpoints. Returns undefined for any other request.
export async function handleUnlockRoute(
  request: Request,
  url: URL,
  origin: string,
  gate: PanelGate,
  open: (password: string) => Promise<void>,
): Promise<Response | undefined> {
  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...headers,
      },
    });
  const path = url.pathname;
  try {
    if (request.method === "GET" && path === "/api/unlock/key")
      return json(200, gate.keyInfo());
    if (request.method === "GET" && path === "/api/unlock/challenge")
      return json(200, { challenge: gate.issueChallenge() });
    if (request.method === "POST" && path === "/api/unlock") {
      if (request.headers.get("Origin") !== origin)
        return json(403, { error: "Open the local panel directly" });
      const input = await request.json().catch(() => undefined);
      await gate.unlock(input, open);
      return json(
        200,
        { unlocked: true },
        { "Set-Cookie": gate.cookieHeader() },
      );
    }
    if (request.method === "POST" && path === "/api/unlock/lock") {
      if (request.headers.get("Origin") !== origin)
        return json(403, { error: "Open the local panel directly" });
      gate.lock();
      return json(200, { unlocked: false });
    }
  } catch (error) {
    if (error instanceof GateError)
      return json(error.status, { error: error.message });
    throw error;
  }
  return undefined;
}
