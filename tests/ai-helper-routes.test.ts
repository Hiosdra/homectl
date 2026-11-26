import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../src/authz";
import type { PolicyDocument } from "../src/core/contracts";
import { AiHelperRoutes } from "../src/broker/ai-helper-routes";
import {
  keyStatus,
  LOCKED_MESSAGE,
  type ReviewerKeyStore,
  reviewerApiKey,
} from "../src/broker/reviewer-key";
import {
  loadReviewerSettings,
  saveReviewerSettings,
} from "../src/broker/reviewer-settings";
import { HomectlError } from "../src/types";

// A key that must never appear in any answer, event, error or file the routes
// write. The canary check below scans every one of them.
const CANARY = "sk-ant-canary-NEVER-SHOW-0002";
const VAULT_KEY = "sk-ant-vault-saved-0003";
const ENV_KEY = "sk-ant-env-wins-0004";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_SETTINGS = {
  version: 1,
  provider: "anthropic",
  endpoint: ANTHROPIC_ENDPOINT,
} as const;

interface Recorded {
  events: { type: string; data: unknown }[];
  fetchUrls: string[];
  fetchHeaders: Record<string, string>[];
}

// An in-memory vault store, standing in for VaultSession behind ReviewerKeyStore.
function memoryKeys(
  initial?: string,
): ReviewerKeyStore & { value: string | undefined; locked: boolean } {
  const store = {
    value: initial,
    locked: false,
    endpoint: undefined as string | undefined,
    state() {
      return store.locked ? ("locked" as const) : ("open" as const);
    },
    read(endpoint: string, legacyEndpoint?: string) {
      if (store.locked) throw new HomectlError(5, LOCKED_MESSAGE);
      return (store.endpoint ?? legacyEndpoint) === endpoint
        ? store.value
        : undefined;
    },
    async save(value: string, endpoint: string) {
      if (store.locked) throw new HomectlError(5, LOCKED_MESSAGE);
      store.value = value;
      store.endpoint = endpoint;
    },
    async remove() {
      if (store.locked) throw new HomectlError(5, LOCKED_MESSAGE);
      store.value = undefined;
    },
  };
  return store;
}

function setup(
  options: {
    env?: Record<string, string>;
    vaultKey?: string;
    stepUpOk?: boolean;
  } = {},
) {
  let doc: PolicyDocument = defaultPolicy("conservative", Date.now());
  const recorded: Recorded = { events: [], fetchUrls: [], fetchHeaders: [] };
  const keys = memoryKeys(options.vaultKey);
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    recorded.fetchUrls.push(String(url));
    recorded.fetchHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(
      JSON.stringify({
        data: [{ id: "claude-haiku-5-5", display_name: "Haiku" }],
        content: [
          {
            type: "text",
            text: JSON.stringify({ verdict: "ask", reason: "ok" }),
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const store = {
    async document() {
      return doc;
    },
    async save(next: PolicyDocument) {
      doc = { ...next, revision: doc.revision + 1 };
      return doc;
    },
  };
  return {
    recorded,
    keys,
    get doc() {
      return doc;
    },
    routes: (settingsPath: string) =>
      new AiHelperRoutes({
        store,
        settingsPath,
        env: options.env ?? {},
        keys,
        fetchImpl,
        events: {
          emit: async (
            type: string,
            _subject: string,
            _audience: string[],
            data: unknown,
          ) => {
            recorded.events.push({ type, data });
          },
        } as never,
      }),
    stepUp: async () => {
      if (options.stepUpOk === false)
        throw new HomectlError(3, "The owner password was not accepted");
    },
  };
}

async function settingsPath() {
  return join(
    await mkdtemp(join(tmpdir(), "homectl-ai-helper-")),
    "reviewer.json",
  );
}

describe("connect: the owner's onboarding confirm", () => {
  test("saves the mode, the provider settings and the key together, and never returns the key", async () => {
    const env = setup();
    const path = await settingsPath();
    const view = (await env.routes(path).owner(
      "/v1/owner/ai-helper/connect",
      {
        preset: "delegated",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        apiKey: CANARY,
        password: "pw",
      },
      env.stepUp,
    )) as Record<string, unknown>;
    expect(env.keys.value).toBe(CANARY);
    expect(env.doc.mode).toBe("auto");
    expect(env.doc.reviewer.authority).toBe("delegated");
    expect(env.doc.reviewer.provider).toBe("anthropic");
    const saved = await loadReviewerSettings(path);
    expect(saved.provider).toBe("anthropic");
    expect(saved.endpoint).toBe("https://api.anthropic.com/v1/messages");
    expect(saved.model).toBe("claude-haiku-5-5");
    expect(JSON.stringify(view)).not.toContain(CANARY);
    expect((view.reviewer as Record<string, unknown>).ready).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain(CANARY);
    expect(JSON.stringify(env.recorded.events)).not.toContain(CANARY);
  });

  test("the password comes first: a refused step-up writes nothing", async () => {
    const env = setup({ stepUpOk: false });
    const path = await settingsPath();
    await expect(
      env.routes(path).owner(
        "/v1/owner/ai-helper/connect",
        {
          preset: "routine",
          provider: "anthropic",
          model: "claude-haiku-5-5",
          apiKey: CANARY,
          password: "bad",
        },
        env.stepUp,
      ),
    ).rejects.toThrow("not accepted");
    expect(env.keys.value).toBeUndefined();
    expect(env.doc.mode).toBe("rules");
    expect(env.doc.reviewer.provider).toBeUndefined();
    await expect(loadReviewerSettings(path)).resolves.toEqual({ version: 1 });
  });

  test("a hosted provider with no key anywhere is refused before any write", async () => {
    const env = setup();
    const path = await settingsPath();
    await expect(
      env.routes(path).owner(
        "/v1/owner/ai-helper/connect",
        {
          preset: "routine",
          provider: "openai",
          model: "gpt-x",
          password: "pw",
        },
        env.stepUp,
      ),
    ).rejects.toThrow("Add the API key first");
    expect(env.doc.reviewer.provider).toBeUndefined();
  });

  test("Custom connects without a key", async () => {
    const env = setup({
      env: { HOMECTL_REVIEWER_API_KEY: ENV_KEY },
      vaultKey: VAULT_KEY,
    });
    const path = await settingsPath();
    await saveReviewerSettings(path, ANTHROPIC_SETTINGS);
    await env.routes(path).owner(
      "/v1/owner/ai-helper/connect",
      {
        preset: "routine",
        provider: "custom",
        baseUrl: "http://localhost:11434/v1",
        model: "llama",
        password: "pw",
      },
      env.stepUp,
    );
    expect((await loadReviewerSettings(path)).endpoint).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(env.doc.reviewer.provider).toBe("openai-compatible");
    const saved = await loadReviewerSettings(path);
    expect(saved.keyEndpoint).toBe(ANTHROPIC_ENDPOINT);
    expect(env.keys.value).toBe(VAULT_KEY);
    expect(
      await reviewerApiKey(
        { HOMECTL_REVIEWER_API_KEY: ENV_KEY },
        env.keys,
        saved,
      ),
    ).toBeUndefined();
  });
});

describe("the key: source, priority and the locked vault", () => {
  test("the environment key wins over the vault key for every call", async () => {
    const env = setup({
      env: { HOMECTL_REVIEWER_API_KEY: ENV_KEY },
      vaultKey: VAULT_KEY,
    });
    const path = await settingsPath();
    await saveReviewerSettings(path, ANTHROPIC_SETTINGS);
    await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/models",
        { provider: "anthropic" },
        env.stepUp,
      );
    expect(env.recorded.fetchHeaders[0]?.["x-api-key"]).toBe(ENV_KEY);
    expect(
      keyStatus(
        { HOMECTL_REVIEWER_API_KEY: ENV_KEY },
        env.keys,
        ANTHROPIC_SETTINGS,
      ),
    ).toEqual({
      source: "environment",
      locked: false,
    });
  });

  test("with no environment key, the saved vault key is used", async () => {
    const env = setup({ vaultKey: VAULT_KEY });
    const path = await settingsPath();
    await saveReviewerSettings(path, ANTHROPIC_SETTINGS);
    await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/models",
        { provider: "anthropic" },
        env.stepUp,
      );
    expect(env.recorded.fetchHeaders[0]?.["x-api-key"]).toBe(VAULT_KEY);
    expect(keyStatus({}, env.keys, ANTHROPIC_SETTINGS)).toEqual({
      source: "vault",
      locked: false,
    });
  });

  test("a locked vault says to unlock and never approves on its own", async () => {
    const env = setup({ vaultKey: VAULT_KEY });
    env.keys.locked = true;
    const path = await settingsPath();
    await saveReviewerSettings(path, ANTHROPIC_SETTINGS);
    const error = await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/models",
        { provider: "anthropic" },
        env.stepUp,
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(LOCKED_MESSAGE);
    expect(env.recorded.fetchUrls).toHaveLength(0);
    await expect(
      reviewerApiKey({}, env.keys, ANTHROPIC_SETTINGS),
    ).rejects.toThrow("Unlock homectl to use the AI helper");
  });

  test("previews of another provider or endpoint do not send an existing key", async () => {
    const env = setup({
      env: { HOMECTL_REVIEWER_API_KEY: ENV_KEY },
      vaultKey: VAULT_KEY,
    });
    const path = await settingsPath();
    await saveReviewerSettings(path, {
      version: 1,
      provider: "custom",
      endpoint: "https://reviewer.example/v1/chat/completions",
    });
    const routes = env.routes(path);
    await routes.owner(
      "/v1/owner/ai-helper/models",
      { provider: "custom", baseUrl: "https://reviewer.example/another-path" },
      env.stepUp,
    );
    expect(env.recorded.fetchHeaders).toEqual([{}]);
    await expect(
      routes.owner(
        "/v1/owner/ai-helper/test",
        { provider: "anthropic", model: "m" },
        env.stepUp,
      ),
    ).rejects.toThrow("Add the API key first");
    expect(env.recorded.fetchUrls).toHaveLength(1);
  });

  test("a key typed during onboarding is used before it is saved", async () => {
    const env = setup();
    const path = await settingsPath();
    await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/models",
        { provider: "anthropic", apiKey: CANARY },
        env.stepUp,
      );
    expect(env.recorded.fetchHeaders[0]?.["x-api-key"]).toBe(CANARY);
    expect(env.keys.value).toBeUndefined();
  });

  test("forget needs the step-up and removes only the vault key", async () => {
    const env = setup({ vaultKey: VAULT_KEY });
    const path = await settingsPath();
    const refused = setup({ vaultKey: VAULT_KEY, stepUpOk: false });
    await expect(
      refused
        .routes(path)
        .owner(
          "/v1/owner/ai-helper/forget-key",
          { password: "x" },
          refused.stepUp,
        ),
    ).rejects.toThrow();
    expect(refused.keys.value).toBe(VAULT_KEY);
    const view = (await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/forget-key",
        { password: "pw" },
        env.stepUp,
      )) as { reviewer: { apiKey: { source: string } } };
    expect(env.keys.value).toBeUndefined();
    expect(view.reviewer.apiKey.source).toBe("none");
  });
});

describe("set-key: the CLI path that stores only the key", () => {
  test("needs the step-up, stores the key, and answers without it", async () => {
    const refused = setup({ stepUpOk: false });
    const path = await settingsPath();
    await expect(
      refused
        .routes(path)
        .owner(
          "/v1/owner/ai-helper/set-key",
          { apiKey: CANARY, password: "bad" },
          refused.stepUp,
        ),
    ).rejects.toThrow("not accepted");
    expect(refused.keys.value).toBeUndefined();

    const env = setup();
    const routes = env.routes(path);
    await expect(
      routes.owner(
        "/v1/owner/ai-helper/set-key",
        { apiKey: CANARY, password: "pw" },
        env.stepUp,
      ),
    ).rejects.toThrow("Set the AI helper endpoint");
    await saveReviewerSettings(path, ANTHROPIC_SETTINGS);
    const view = await env
      .routes(path)
      .owner(
        "/v1/owner/ai-helper/set-key",
        { apiKey: CANARY, password: "pw" },
        env.stepUp,
      );
    expect(env.keys.value).toBe(CANARY);
    expect(JSON.stringify(view)).not.toContain(CANARY);
    // The mode and the settings are untouched by a key-only save.
    expect(env.doc.mode).toBe("rules");
    await expect(loadReviewerSettings(path)).resolves.toEqual(
      ANTHROPIC_SETTINGS,
    );
  });

  test("an empty key is refused before the password is checked", async () => {
    const env = setup();
    const path = await settingsPath();
    let checked = false;
    await expect(
      env
        .routes(path)
        .owner(
          "/v1/owner/ai-helper/set-key",
          { apiKey: "   ", password: "pw" },
          async () => {
            checked = true;
          },
        ),
    ).rejects.toThrow("Paste the key first");
    expect(checked).toBe(false);
  });
});

describe("canary", () => {
  test("no route answer, error or event contains a key canary", async () => {
    const env = setup({ vaultKey: VAULT_KEY });
    const path = await settingsPath();
    const outputs: unknown[] = [];
    outputs.push(
      await env
        .routes(path)
        .owner(
          "/v1/owner/ai-helper/models",
          { provider: "anthropic", apiKey: CANARY },
          env.stepUp,
        ),
    );
    outputs.push(
      await env.routes(path).owner(
        "/v1/owner/ai-helper/connect",
        {
          preset: "routine",
          provider: "anthropic",
          model: "claude-haiku-5-5",
          apiKey: CANARY,
          password: "pw",
        },
        env.stepUp,
      ),
    );
    outputs.push(env.recorded.events);
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(VAULT_KEY);
  });
});
