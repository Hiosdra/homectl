import { expect, test } from "bun:test";
import type { localApi } from "../src/peer/local-api";
import { sessionWorkspace } from "../src/session/workspace";
import { HomectlError } from "../src/types";

test("SSH already unlocked still unlocks sync with one private prompt", async () => {
  let unlocked = false,
    prompts = 0;
  const calls: string[] = [];
  const api: typeof localApi = async <T>(
    _path: string,
    route: string,
    value?: unknown,
  ) => {
    calls.push(route);
    if (route === "/api/vault/unlock") {
      expect((value as { password: string }).password).toBe(
        "synthetic-vault-password",
      );
      unlocked = true;
    }
    return {
      vaultUnlocked: unlocked,
      session: { unlocked: true, expiresAt: null },
    } as T;
  };
  const result = await sessionWorkspace(
    "unlock",
    { version: 1, machines: {} },
    "fixture",
    async () => {
      prompts++;
      return "synthetic-vault-password";
    },
    api,
  );
  expect(prompts).toBe(1);
  expect(result.syncUnlocked).toBe(true);
  expect(calls).toContain("/api/vault/unlock");
});
test("workspace lock uses the route that clears both vault and SSH", async () => {
  const calls: string[] = [];
  const api: typeof localApi = async <T>(_path: string, route: string) => {
    calls.push(route);
    return { vaultUnlocked: true, session: { unlocked: true } } as T;
  };
  const result = await sessionWorkspace(
    "lock",
    { version: 1, machines: {} },
    "fixture",
    async () => {
      throw new Error("must not prompt");
    },
    api,
  );
  expect(calls).toContain("/api/vault/lock");
  expect(result.syncUnlocked).toBe(false);
});
test("invalid workspace authentication is not silently treated as SSH-only", async () => {
  const api: typeof localApi = async () => {
    throw new HomectlError(
      5,
      "Panel access changed; restart the private panel session",
    );
  };
  await expect(
    sessionWorkspace(
      "lock",
      { version: 1, machines: {} },
      "fixture",
      undefined,
      api,
    ),
  ).rejects.toThrow("Panel access changed");
});

test.each(["ECONNREFUSED", "EACCES"])(
  "an unavailable local panel falls back to private SSH unlock (%s)",
  async (code) => {
    const api: typeof localApi = async () => {
      const failure = new Error("local panel unavailable");
      if (code === "EACCES") Object.assign(failure, { code });
      else Object.assign(failure, { cause: { code } });
      throw failure;
    };
    let unlocked = false;
    const result = await sessionWorkspace(
      "unlock",
      { version: 1, machines: {} },
      "fixture",
      async () => {
        throw new Error("fallback should not prompt in this test");
      },
      api,
      async () => {
        unlocked = true;
        return { unlocked: true, note: "private unlock" };
      },
    );
    expect(unlocked).toBe(true);
    expect(result.unlocked).toBe(true);
    expect(result.syncUnlocked).toBe(false);
  },
);
