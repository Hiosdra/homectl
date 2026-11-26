// Where the AI helper's API key lives (0.3). The owner pastes it in the panel;
// the broker keeps it as one entry in the encrypted vault, in the homectl/api
// group. The HOMECTL_REVIEWER_API_KEY environment variable, when set, wins.
// The key is read only when the reviewer needs it, is never returned by any
// API or logged, and a locked vault means no key: the owner decides instead.
import { HomectlError } from "../types";
import type { VaultSession } from "../vault";
import { GROUPS } from "../vault/groups";
import {
  environmentReviewerKey,
  keyEndpointOf,
  type ReviewerSettings,
} from "./reviewer-settings";

export const REVIEWER_KEY_ENTRY = "homectl/reviewer-api-key";
export const REVIEWER_KEY_FIELD = "API key";
const ENDPOINT_FIELD = "Reviewer endpoint";

export const LOCKED_MESSAGE =
  "Unlock homectl to use the AI helper. Until then, you decide each request.";

// "open": the vault can be read and written. "locked": the vault exists but is
// closed. "absent": no vault has been set up, so a key cannot be saved.
export type VaultState = "open" | "locked" | "absent";

export interface ReviewerKeyStore {
  state(): VaultState;
  // The saved key, or undefined when none is saved. Throws the locked message
  // when the vault is closed.
  read(endpoint: string, legacyEndpoint?: string): string | undefined;
  save(value: string, endpoint: string): Promise<void>;
  remove(): Promise<void>;
}

// Where the key the reviewer uses comes from, for the panel. Never the key.
export type KeySource = "environment" | "vault" | "none";

export interface KeyStatus {
  source: KeySource;
  // True when the vault is closed, so a saved key cannot be checked.
  locked: boolean;
}

export function keyStatus(
  env: Record<string, string | undefined>,
  store: ReviewerKeyStore | undefined,
  settings: ReviewerSettings,
): KeyStatus {
  if (environmentReviewerKey(env, settings) !== undefined)
    return { source: "environment", locked: false };
  if (store === undefined || settings.endpoint === undefined)
    return { source: "none", locked: false };
  const state = store.state();
  if (state === "locked") return { source: "none", locked: true };
  if (state === "absent") return { source: "none", locked: false };
  return {
    source:
      store.read(settings.endpoint, keyEndpointOf(settings)) === undefined
        ? "none"
        : "vault",
    locked: false,
  };
}

// The key the reviewer uses: the environment first, then the vault. A closed
// vault throws the locked message, which makes the review fail and the owner
// decide. The key is never logged.
export async function reviewerApiKey(
  env: Record<string, string | undefined>,
  store: ReviewerKeyStore,
  settings: ReviewerSettings,
): Promise<string | undefined> {
  if (settings.endpoint === undefined) return undefined;
  const fromEnv = environmentReviewerKey(env, settings);
  if (fromEnv !== undefined) return fromEnv;
  if (store.state() === "locked") throw new HomectlError(5, LOCKED_MESSAGE);
  return store.read(settings.endpoint, keyEndpointOf(settings));
}

// The store over an open VaultSession. The session expires and locks itself,
// so every call checks it again.
export function vaultReviewerKey(
  session: Pick<
    VaultSession,
    "check" | "listEntries" | "getSecret" | "putSecret" | "removeEntry"
  >,
  present: boolean,
): ReviewerKeyStore {
  const entryId = (): string | undefined =>
    session.listEntries().find((entry) => entry.name === REVIEWER_KEY_ENTRY)
      ?.id;
  return {
    state() {
      if (!present) return "absent";
      return session.check() ? "open" : "locked";
    },
    read(endpoint, legacyEndpoint) {
      if (!present) return undefined;
      if (!session.check()) throw new HomectlError(5, LOCKED_MESSAGE);
      const id = entryId();
      if (id === undefined) return undefined;
      const fields = session.getSecret(id);
      if ((fields[ENDPOINT_FIELD] ?? legacyEndpoint) !== endpoint)
        return undefined;
      const value = fields[REVIEWER_KEY_FIELD];
      return value && value.length > 0 ? value : undefined;
    },
    async save(value, endpoint) {
      if (!present)
        throw new HomectlError(
          5,
          "The encrypted vault is not set up yet, so the AI helper key cannot be saved. Set up the vault first.",
        );
      if (!session.check()) throw new HomectlError(5, LOCKED_MESSAGE);
      await session.putSecret(
        REVIEWER_KEY_ENTRY,
        { [REVIEWER_KEY_FIELD]: value, [ENDPOINT_FIELD]: endpoint },
        { group: GROUPS.api },
      );
    },
    async remove() {
      if (!present) return;
      if (!session.check()) throw new HomectlError(5, LOCKED_MESSAGE);
      const id = entryId();
      if (id !== undefined) await session.removeEntry(id);
    },
  };
}
