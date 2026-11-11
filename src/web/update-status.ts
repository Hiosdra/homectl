// Update banner data. Asks the public GitHub releases API for the latest release and
// compares it with this build. The request carries no user data. The answer is cached
// for a day, and a failed check is reported in the status instead of thrown.
export const RELEASE_API =
  "https://api.github.com/repos/Hiosdra/homectl/releases/latest";

import { VERSION } from "../container/health";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UpdateStatus = {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  checkedAt?: number;
  error?: string;
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export function parseVersion(
  text: string,
): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// True when `latest` is a newer release than `current`. Unparseable versions are never newer.
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export class UpdateChecker {
  readonly #current: string;
  readonly #fetch: Fetcher;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #cached: { at: number; tag: string; url: string } | undefined;

  constructor(options: {
    current: string;
    fetch?: Fetcher;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#current = options.current;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DAY_MS;
  }

  async status(): Promise<UpdateStatus> {
    const now = this.#now();
    if (!this.#cached || now - this.#cached.at >= this.#ttlMs) {
      try {
        const response = await this.#fetch(RELEASE_API, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "homectl",
          },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`release check returned ${response.status}`);
        const release = (await response.json()) as {
          tag_name?: unknown;
          html_url?: unknown;
        };
        if (
          typeof release.tag_name !== "string" ||
          typeof release.html_url !== "string"
        )
          throw new Error("release check returned an unexpected answer");
        this.#cached = {
          at: now,
          tag: release.tag_name,
          url: release.html_url,
        };
      } catch (error) {
        return {
          current: this.#current,
          available: false,
          error:
            error instanceof Error ? error.message : "release check failed",
        };
      }
    }
    const { at, tag, url } = this.#cached;
    return {
      current: this.#current,
      latest: tag.replace(/^v/, ""),
      available: isNewer(tag, this.#current),
      url,
      checkedAt: at,
    };
  }
}

// Route handler for GET /api/update. Returns undefined for any other request.
export async function handleUpdateRoute(
  request: Request,
  url: URL,
  checker: UpdateChecker,
): Promise<Response | undefined> {
  if (request.method !== "GET" || url.pathname !== "/api/update")
    return undefined;
  return new Response(JSON.stringify(await checker.status()), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// The panel's checker: one per process, sharing the day-long cache.
export const updateChecker = new UpdateChecker({ current: VERSION });
