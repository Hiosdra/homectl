import { describe, expect, test } from "bun:test";
import {
  REVIEWER_KEY_ENTRY,
  vaultReviewerKey,
} from "../src/broker/reviewer-key";
import type { VaultSession } from "../src/vault";

const CANARY = "fixture-reviewer-key";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

describe("reviewer vault key", () => {
  test("a vault that was never set up cannot store the key", async () => {
    const session = {
      check: () => true,
      listEntries: () => [],
      getSecret: () => ({}),
      putSecret: async () => ({}),
      removeEntry: async () => undefined,
    } as unknown as Pick<
      VaultSession,
      "check" | "listEntries" | "getSecret" | "putSecret" | "removeEntry"
    >;
    const absent = vaultReviewerKey(session, false);
    expect(absent.state()).toBe("absent");
    await expect(absent.save(CANARY, ANTHROPIC_ENDPOINT)).rejects.toThrow(
      "not set up yet",
    );
  });

  test("vault entries are read and written under one name, in the api group", async () => {
    const written: {
      name: string;
      values: Record<string, string>;
      group?: string;
    }[] = [];
    let entries: { id: string; name: string }[] = [];
    const secrets: Record<string, Record<string, string>> = {};
    const session = {
      check: () => true,
      listEntries: () => entries,
      getSecret: (id: string) => secrets[id] ?? {},
      putSecret: async (
        name: string,
        values: Record<string, string>,
        options: { group?: string },
      ) => {
        written.push({ name, values, group: options.group });
        entries = [{ id: "e1", name }];
        secrets.e1 = values;
        return {};
      },
      removeEntry: async (id: string) => {
        entries = entries.filter((entry) => entry.id !== id);
      },
    } as unknown as Pick<
      VaultSession,
      "check" | "listEntries" | "getSecret" | "putSecret" | "removeEntry"
    >;
    const store = vaultReviewerKey(session, true);
    await store.save(CANARY, ANTHROPIC_ENDPOINT);
    expect(written[0]?.name).toBe(REVIEWER_KEY_ENTRY);
    expect(written[0]?.group).toBe("homectl/api");
    expect(store.read(ANTHROPIC_ENDPOINT)).toBe(CANARY);
    expect(
      store.read("https://example.test/v1", "https://example.test/v1"),
    ).toBeUndefined();
    secrets.e1 = { "API key": CANARY };
    expect(store.read(ANTHROPIC_ENDPOINT, ANTHROPIC_ENDPOINT)).toBe(CANARY);
    expect(
      store.read("https://example.test/v1", ANTHROPIC_ENDPOINT),
    ).toBeUndefined();
    await store.remove();
    expect(store.read(ANTHROPIC_ENDPOINT)).toBeUndefined();
  });
});
