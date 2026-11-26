// Owner routes for homectl self-update from the panel (homelab #21 §8).
//
// Status reads the public release, the signed manifest of the offered version and
// this install's facts. It changes nothing. Apply needs the owner password, checks
// the signature of exactly one offered version, and then runs the staged install
// the CLI already uses (installRelease in src/update-apply.ts). A source checkout,
// a container, a package-manager install or an unsupported platform gets the reason
// instead, and nothing is downloaded for it.
import { existsSync } from "node:fs";
import { VERSION } from "../container/health";
import { bundled as compiledBuild } from "../internal";
import {
  MANIFEST_NAME,
  parseManifest,
  RELEASE_SIGNING_KEYS,
  SIGNATURE_NAME,
  type TrustPolicy,
  verifySignature,
} from "../release-trust";
import {
  installRelease,
  RELEASE_DOWNLOAD_BASE,
  type UpdateApplied,
  type UpdateApplyOptions,
} from "../update-apply";
import { isNewer, UpdateChecker } from "../update-check";
import { HomectlError } from "../types";
import type { RouteExtension } from "./server";
import type { EventsPort } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const VERSION_TEXT = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export type SignatureState = "verified" | "failed" | "unverified" | "unknown";
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Installer = (
  version: string,
  options: UpdateApplyOptions,
) => Promise<UpdateApplied>;

// How this copy of homectl was installed and what it runs on.
export interface InstallFacts {
  bundled: boolean;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  container: boolean;
}

export interface UpdateStatusView {
  current: string;
  latest?: string;
  available: boolean;
  signature: SignatureState;
  canApply: boolean;
  reason?: string;
}

export function installFacts(): InstallFacts {
  return {
    bundled: compiledBuild,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  };
}

// A heuristic: the install path shows a package manager (Scoop, WinGet, Chocolatey,
// Homebrew, Nix, snap, Flatpak or a system package directory).
const PACKAGE_MANAGER_DIRS = [
  "/scoop/",
  "/winget/",
  "/windowsapps/",
  "/chocolatey/",
  "/homebrew/",
  "/cellar/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/lib/",
  "/nix/store/",
  "/snap/",
  "/var/lib/flatpak/",
];

export function isPackageManagerPath(path: string): boolean {
  const normal = path.replaceAll("\\", "/").toLowerCase();
  return PACKAGE_MANAGER_DIRS.some((dir) => normal.includes(dir));
}

// Why this install cannot be updated from the panel; undefined when it can.
export function blockedReason(facts: InstallFacts): string | undefined {
  if (facts.container)
    return "This broker runs in a container. Update it by redeploying its image.";
  if (!facts.bundled)
    return "This broker runs from a source checkout. Update it with home-ctl update in the checkout.";
  if (isPackageManagerPath(facts.execPath))
    return "A package manager owns this install. Update it with that package manager.";
  if (facts.platform !== "win32" || facts.arch !== "x64")
    return "Update from the panel is available for Windows x64 release builds. Install the newer release from the release page on this platform.";
  return undefined;
}

// Reads the release's signed manifest and checks it for `version`. Never throws:
// "unverified" means the release has no signed manifest to check, "unknown" means
// the check could not reach it, and "failed" means something was checked and refused.
export async function checkSignature(
  version: string,
  options: { fetch: Fetcher; trust?: TrustPolicy },
): Promise<SignatureState> {
  const keys = options.trust?.keys ?? RELEASE_SIGNING_KEYS;
  if (keys.length === 0) return "unverified";
  const base = `${RELEASE_DOWNLOAD_BASE}/v${version}`;
  const init = { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) };
  let manifest: Uint8Array;
  let signature: string;
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      options.fetch(`${base}/${MANIFEST_NAME}`, init),
      options.fetch(`${base}/${SIGNATURE_NAME}`, init),
    ]);
    if (!manifestResponse.ok || !signatureResponse.ok) return "unverified";
    manifest = new Uint8Array(await manifestResponse.arrayBuffer());
    signature = new TextDecoder().decode(await signatureResponse.arrayBuffer());
  } catch {
    return "unknown";
  }
  try {
    verifySignature(manifest, signature, options.trust);
    return parseManifest(manifest).version === version ? "verified" : "failed";
  } catch {
    return "failed";
  }
}

const REFUSED_SIGNATURE: Record<Exclude<SignatureState, "verified">, string> = {
  failed: "The release signature does not verify. Nothing was installed.",
  unverified:
    "The release has no signed manifest to check. Nothing was installed.",
  unknown:
    "The release signature could not be checked right now. Nothing was installed.",
};

export interface UpdateRoutesOptions {
  current?: string;
  fetch?: Fetcher;
  now?: () => number;
  // How long a release check and its signature verdict are reused.
  ttlMs?: number;
  trust?: TrustPolicy;
  facts?: InstallFacts;
  install?: Installer;
  events?: EventsPort;
}

export class UpdateRoutes implements RouteExtension {
  readonly #current: string;
  readonly #fetch: Fetcher;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #trust: TrustPolicy | undefined;
  readonly #facts: InstallFacts;
  readonly #install: Installer;
  readonly #checker: UpdateChecker;
  readonly #events: EventsPort | undefined;
  #signed: { version: string; at: number; state: SignatureState } | undefined;

  constructor(options: UpdateRoutesOptions = {}) {
    this.#current = options.current ?? VERSION;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? HOUR_MS;
    this.#trust = options.trust;
    this.#facts = options.facts ?? installFacts();
    this.#install = options.install ?? installRelease;
    this.#events = options.events;
    this.#checker = new UpdateChecker({
      current: this.#current,
      fetch: this.#fetch,
      now: this.#now,
      ttlMs: this.#ttlMs,
    });
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/update/status":
        return this.status();
      case "/v1/owner/update/apply":
        return this.apply(input, stepUp);
      default:
        return undefined;
    }
  }

  async status(): Promise<UpdateStatusView> {
    const release = await this.#checker.status();
    const latest = release.latest;
    const signature =
      latest === undefined ? "unknown" : await this.signatureOf(latest);
    const reason = blockedReason(this.#facts);
    return {
      current: this.#current,
      ...(latest === undefined ? {} : { latest }),
      available: release.available,
      signature,
      canApply: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private async apply(
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ) {
    // First: no install is prepared, let alone started, without the owner password.
    await stepUp(input.password);
    const requested = requestedVersion(input.version);
    const reason = blockedReason(this.#facts);
    if (reason) throw new HomectlError(4, `${reason} Nothing was installed.`);
    const release = await this.#checker.status();
    if (release.latest === undefined)
      throw new HomectlError(
        5,
        "The release check failed, so no version can be installed right now. Nothing was installed.",
      );
    if (requested !== release.latest)
      throw new HomectlError(
        4,
        `Only the offered version ${release.latest} can be installed here, not ${requested}. Nothing was installed.`,
      );
    if (!isNewer(requested, this.#current))
      throw new HomectlError(
        4,
        `Refusing to install ${requested}: it is not newer than the running ${this.#current}. Nothing was installed.`,
      );
    // Checked fresh, not from the cache: the signature of this exact version decides.
    const signature = await checkSignature(requested, {
      fetch: this.#fetch,
      trust: this.#trust,
    });
    if (signature !== "verified")
      throw new HomectlError(5, REFUSED_SIGNATURE[signature]);

    let applied: UpdateApplied;
    try {
      applied = await this.#install(requested, {
        fetcher: (url) => this.#fetch(url),
        ...(this.#trust ? { trust: this.#trust } : {}),
        current: this.#current,
      });
    } catch (error) {
      await this.audit(requested, "failed");
      throw error;
    }
    await this.audit(requested, "staged");
    return {
      state: "staged",
      version: requested,
      ...(applied.next ? { next: applied.next } : {}),
    };
  }

  private async audit(version: string, state: "staged" | "failed") {
    await this.#events?.emit("device.updated", "homectl", ["owner"], {
      from: this.#current,
      to: version,
      state,
    });
  }

  private async signatureOf(version: string): Promise<SignatureState> {
    const now = this.#now();
    const cached = this.#signed;
    if (cached && cached.version === version && now - cached.at < this.#ttlMs)
      return cached.state;
    const state = await checkSignature(version, {
      fetch: this.#fetch,
      trust: this.#trust,
    });
    // A failed network check is not remembered; the next status asks again.
    if (state !== "unknown") this.#signed = { version, at: now, state };
    return state;
  }
}

// Accepts 0.3.1 or v0.3.1 and returns the bare form; anything else is refused.
function requestedVersion(value: unknown): string {
  const match =
    typeof value === "string" ? VERSION_TEXT.exec(value.trim()) : null;
  if (!match) throw new HomectlError(2, "version must look like 0.3.1");
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}
