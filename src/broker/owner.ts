// Owner authentication for owner surfaces (panel, private CLI). The owner
// proves knowledge of the owner secret (the vault master password once the
// vault module is wired; a dedicated argon2id verifier until then). Sessions
// are short, in memory only, and never usable on agent routes. Step-up means
// presenting the secret again for one decision.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { argon2id } from "hash-wasm";
import { atomicReplace, protect } from "../platform";
import { HomectlError } from "../types";

export interface OwnerVerifier {
  verify(secret: string): Promise<boolean>;
}

export const OWNER_SESSION_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

interface VerifierFile {
  version: 1;
  salt: string;
  hash: string;
  params: { iterations: number; memorySize: number; parallelism: number };
}

const DEFAULT_PARAMS = { iterations: 3, memorySize: 65536, parallelism: 1 };

async function derive(
  secret: string,
  salt: Buffer,
  params: VerifierFile["params"],
): Promise<Buffer> {
  const hex = await argon2id({
    password: secret,
    salt,
    ...params,
    hashLength: 32,
    outputType: "hex",
  });
  return Buffer.from(hex, "hex");
}

// argon2id verifier stored beside the broker state (mode 0600).
export class FileVerifier implements OwnerVerifier {
  constructor(
    private readonly path: string,
    private readonly params = DEFAULT_PARAMS,
  ) {}

  async exists(): Promise<boolean> {
    try {
      await readFile(this.path);
      return true;
    } catch {
      return false;
    }
  }

  async set(secret: string): Promise<void> {
    if (secret.length < 12)
      throw new HomectlError(
        2,
        "Use an owner password of at least 12 characters",
      );
    const salt = randomBytes(16);
    const record: VerifierFile = {
      version: 1,
      salt: salt.toString("base64"),
      hash: (await derive(secret, salt, this.params)).toString("base64"),
      params: this.params,
    };
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, this.path);
    await protect(this.path);
  }

  async verify(secret: string): Promise<boolean> {
    let record: VerifierFile;
    try {
      record = JSON.parse(await readFile(this.path, "utf8")) as VerifierFile;
    } catch {
      return false;
    }
    if (record.version !== 1) return false;
    const actual = await derive(
      secret,
      Buffer.from(record.salt, "base64"),
      record.params,
    );
    const expected = Buffer.from(record.hash, "base64");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}

export interface OwnerSession {
  token: string;
  surface: string;
  expiresAt: number;
}

// In-memory sessions plus failure lockout. Restarting the daemon logs the
// owner out everywhere.
export class OwnerSessions {
  private readonly sessions = new Map<string, OwnerSession>();
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly verifier: OwnerVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  // Checks the secret with lockout. Used for login and for step-up.
  async check(secret: unknown): Promise<boolean> {
    const now = this.now();
    if (now < this.lockedUntil)
      throw new HomectlError(
        3,
        "Too many wrong passwords; wait a minute and try again",
      );
    if (typeof secret !== "string" || !secret || secret.length > 1024) {
      this.fail(now);
      return false;
    }
    if (await this.verifier.verify(secret)) {
      this.failures = 0;
      return true;
    }
    this.fail(now);
    return false;
  }

  private fail(now: number) {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = now + LOCKOUT_MS;
    }
  }

  async login(secret: unknown, surface: string): Promise<OwnerSession> {
    if (!(await this.check(secret)))
      throw new HomectlError(3, "Wrong owner password");
    const session = {
      token: `hco_${randomBytes(32).toString("base64url")}`,
      surface,
      expiresAt: this.now() + OWNER_SESSION_MS,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  resolve(token: string | undefined): OwnerSession | undefined {
    if (!token?.startsWith("hco_")) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }

  // Lock / emergency stop: every owner session ends.
  clear() {
    this.sessions.clear();
  }
}
