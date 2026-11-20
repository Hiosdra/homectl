// Auto Mode settings (homelab #21 A1/A2): step-up for authority changes, the
// planner, endpoint validation, and the HTTP reviewer against a loopback fake.
// The verdict behaviour itself is in broker-auto-mode.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../src/authz";
import { AuthzPolicy } from "../src/broker/authz-policy";
import { parseAutoModeChange, planAutoMode } from "../src/broker/auto-mode";
import { AutoModeRoutes } from "../src/broker/auto-mode-routes";
import {
  loadReviewerSettings,
  normalizeEndpoint,
  reviewerFrom,
  type ReviewerSettings,
  saveReviewerSettings,
} from "../src/broker/reviewer-settings";
import type { EventsPort } from "../src/broker/types";
import type { ActionRequest } from "../src/core/contracts";
import { HomectlError } from "../src/types";

const clock = 1_800_000_000_000;
const now = () => clock;
const KEY_CANARY = "canary-reviewer-key-7d1";
const restart = ["systemctl", "restart", "nginx"];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-auto-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("authority changes and step-up", () => {
  const stepUp = (password: unknown) =>
    password === "owner-pw"
      ? Promise.resolve()
      : Promise.reject(new HomectlError(3, "Confirm with the owner password"));

  function routes(env: Record<string, string | undefined> = {}) {
    const store = new AuthzPolicy({ path: join(dir, "policy.json"), now });
    const settingsPath = join(dir, "reviewer.json");
    const events: {
      type: string;
      subject: string;
      audience: string[];
      data: Record<string, unknown>;
    }[] = [];
    const port: EventsPort = {
      emit: async (type, subject, audience, data) => {
        events.push({ type, subject, audience, data });
      },
    };
    const handler = new AutoModeRoutes({
      store,
      settingsPath,
      env,
      events: port,
    });
    const call = (path: string, input: Record<string, unknown>) =>
      handler.owner(path, input, stepUp);
    return { store, settingsPath, events, call };
  }

  test("widening the reviewer authority needs the owner password; narrowing does not", async () => {
    const { store, call } = routes();
    await expect(
      call("/v1/owner/auto-mode/set", { authority: "routine" }),
    ).rejects.toThrow("Confirm with the owner password");
    // Nothing was written by the refused request.
    expect((await store.document()).reviewer.authority).toBe("recommend");

    await call("/v1/owner/auto-mode/set", {
      authority: "delegated",
      password: "owner-pw",
    });
    expect((await store.document()).reviewer.authority).toBe("delegated");

    await call("/v1/owner/auto-mode/set", { authority: "recommend" });
    expect((await store.document()).reviewer.authority).toBe("recommend");
  });

  test("Auto Mode needs an endpoint and model; a new endpoint needs step-up", async () => {
    const { store, settingsPath, call, events } = routes();
    await expect(
      call("/v1/owner/auto-mode/set", { mode: "auto", password: "owner-pw" }),
    ).rejects.toThrow("needs a reviewer endpoint");

    await call("/v1/owner/auto-mode/set", {
      endpoint: "http://127.0.0.1:9/v1/chat/completions",
      model: "test-model",
      password: "owner-pw",
    });
    await expect(
      call("/v1/owner/auto-mode/set", { mode: "auto" }),
    ).rejects.toThrow("Confirm with the owner password");
    await expect(
      call("/v1/owner/auto-mode/set", {
        endpoint: "http://127.0.0.1:10/v1/chat/completions",
      }),
    ).rejects.toThrow("Confirm with the owner password");

    const saved = await call("/v1/owner/auto-mode/set", {
      mode: "auto",
      password: "owner-pw",
    });
    expect(saved).toMatchObject({ mode: "auto" });
    expect((await store.document()).reviewer.provider).toBe(
      "openai-compatible",
    );
    expect((await loadReviewerSettings(settingsPath)).endpoint).toBe(
      "http://127.0.0.1:9/v1/chat/completions",
    );
    // Audit: one settings.updated per saved change, addressed to the owner
    // only and showing the origin, never the path.
    const audit = events.filter((e) => e.type === "settings.updated");
    expect(audit).toHaveLength(2);
    expect(audit[1]?.audience).toEqual(["owner"]);
    expect(audit[1]?.data).toMatchObject({
      endpoint: "http://127.0.0.1:9",
      stepUp: true,
    });
    expect(JSON.stringify(audit)).not.toContain("/v1/chat/completions");
  });

  test("the owner view and the settings file never hold the reviewer API key", async () => {
    const { call, settingsPath } = routes({
      HOMECTL_REVIEWER_API_KEY: KEY_CANARY,
    });
    const view = await call("/v1/owner/auto-mode/set", {
      endpoint: "http://127.0.0.1:9/v1/chat/completions",
      model: "test-model",
      password: "owner-pw",
    });
    expect(JSON.stringify(view)).not.toContain(KEY_CANARY);
    expect(view).toMatchObject({
      reviewer: {
        endpoint: "http://127.0.0.1:9",
        apiKeyConfigured: true,
        ready: true,
      },
    });
    const onDisk = await readFile(settingsPath, "utf8");
    expect(onDisk).not.toContain(KEY_CANARY);
    // The endpoint itself is stored (it is configuration, not a secret).
    expect(onDisk).toContain("http://127.0.0.1:9/v1/chat/completions");
  });

  test("unknown fields and empty changes are refused", async () => {
    const { call } = routes();
    await expect(
      call("/v1/owner/auto-mode/set", { authorty: "delegated" }),
    ).rejects.toThrow("Unknown field");
    await expect(
      call("/v1/owner/auto-mode/set", { password: "owner-pw" }),
    ).rejects.toThrow("Nothing to change");
  });
});

describe("planning and endpoint validation", () => {
  const doc = () => defaultPolicy("conservative", clock);
  const none: ReviewerSettings = { version: 1 };

  test("endpoints must be https or loopback http, with no credentials", () => {
    expect(
      normalizeEndpoint("https://api.example.com/v1/chat/completions"),
    ).toBe("https://api.example.com/v1/chat/completions");
    expect(normalizeEndpoint("http://127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/v1",
    );
    expect(() => normalizeEndpoint("http://api.example.com/v1")).toThrow(
      "https",
    );
    expect(() =>
      normalizeEndpoint("https://user:secret@api.example.com/v1"),
    ).toThrow("credentials");
    expect(() => normalizeEndpoint("not a url")).toThrow("not a valid URL");
  });

  test("the planner marks only widening, enabling Auto or a new endpoint for step-up", () => {
    const withEndpoint: ReviewerSettings = {
      version: 1,
      endpoint: "https://api.example.com/v1/chat/completions",
      model: "m",
    };
    const routine = planAutoMode(doc(), withEndpoint, { authority: "routine" });
    expect(routine.stepUp).toBe(true);
    const narrowed = planAutoMode(
      { ...doc(), reviewer: { ...doc().reviewer, authority: "delegated" } },
      withEndpoint,
      { authority: "recommend" },
    );
    expect(narrowed.stepUp).toBe(false);
    expect(planAutoMode(doc(), withEndpoint, { endpoint: null }).stepUp).toBe(
      false,
    );
    expect(
      planAutoMode(doc(), withEndpoint, {
        endpoint: "https://api.example.com/v1/chat/completions",
      }).stepUp,
    ).toBe(false);
    expect(() => planAutoMode(doc(), none, { mode: "auto" })).toThrow(
      "needs a reviewer endpoint",
    );
    expect(() =>
      planAutoMode(doc(), none, { endpoint: "https://x.example/v1" }),
    ).toThrow("needs a model");
    expect(() => parseAutoModeChange({ mode: "yolo" })).toThrow(
      "mode must be one of",
    );
  });

  test("a missing or damaged settings file means no reviewer", async () => {
    const path = join(dir, "reviewer.json");
    expect(await loadReviewerSettings(path)).toEqual({ version: 1 });
    expect(reviewerFrom(await loadReviewerSettings(path), {})).toBeUndefined();
    await saveReviewerSettings(path, {
      version: 1,
      endpoint: "https://api.example.com/v1",
      model: "m",
    });
    expect(reviewerFrom(await loadReviewerSettings(path), {})).toBeDefined();
    await Bun.write(path, "{not json");
    await expect(loadReviewerSettings(path)).rejects.toThrow("corrupt");
  });
});

describe("the HTTP reviewer end to end", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("allow, malformed and slow loopback replies behave as specified", async () => {
    let reply: "good" | "malformed" | "slow" = "good";
    const seen: (string | null)[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        seen.push(req.headers.get("authorization"));
        if (reply === "slow") await Bun.sleep(1500);
        if (reply === "malformed")
          return Response.json({
            choices: [{ message: { content: "allow it" } }],
          });
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "allow",
                  reason: "read only",
                }),
              },
            },
          ],
        });
      },
    });
    const settingsPath = join(dir, "reviewer.json");
    await saveReviewerSettings(settingsPath, {
      version: 1,
      endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      model: "test-model",
    });
    const policy = new AuthzPolicy({
      path: join(dir, "policy.json"),
      now,
      reviewer: async () =>
        reviewerFrom(await loadReviewerSettings(settingsPath), {
          HOMECTL_REVIEWER_API_KEY: KEY_CANARY,
        }),
      reviewerTimeoutMs: 300,
    });
    const base = defaultPolicy("routine", clock);
    await policy.save({
      ...base,
      mode: "auto",
      reviewer: {
        authority: "routine",
        fallback: "ask",
        maxRisk: "R2",
        provider: "openai-compatible",
      },
    });
    const req: ActionRequest = {
      client: "codex-pc",
      kind: "exec",
      host: "nas",
      argv: restart,
      sudo: false,
      classification: "mutation",
      risk: "R2",
    };
    const ctx = { clientRiskPoints: 0, knownHost: true, now: clock };

    const good = await policy.evaluate(req, ctx);
    expect(good).toMatchObject({
      verdict: "allow",
      source: "reviewer",
      modelCalls: 1,
    });
    expect(seen.at(-1)).toBe(`Bearer ${KEY_CANARY}`);

    reply = "malformed";
    const malformed = await policy.evaluate(req, ctx);
    expect(malformed).toMatchObject({
      verdict: "ask",
      source: "default",
      modelCalls: 1,
    });

    reply = "slow";
    const slow = await policy.evaluate(req, ctx);
    expect(slow).toMatchObject({
      verdict: "ask",
      source: "default",
      modelCalls: 1,
    });

    expect(await readFile(settingsPath, "utf8")).not.toContain(KEY_CANARY);
  });

  test("a damaged reviewer settings file asks the owner instead of failing", async () => {
    const settingsPath = join(dir, "reviewer.json");
    await Bun.write(settingsPath, "{broken");
    const policy = new AuthzPolicy({
      path: join(dir, "policy.json"),
      now,
      reviewer: async () =>
        reviewerFrom(await loadReviewerSettings(settingsPath), {}),
    });
    const base = defaultPolicy("routine", clock);
    await policy.save({
      ...base,
      mode: "auto",
      reviewer: {
        authority: "routine",
        fallback: "ask",
        maxRisk: "R2",
        provider: "openai-compatible",
      },
    });
    const decision = await policy.evaluate(
      {
        client: "codex-pc",
        kind: "exec",
        host: "nas",
        argv: restart,
        classification: "mutation",
        risk: "R2",
      },
      { clientRiskPoints: 0, knownHost: true, now: clock },
    );
    expect(decision.verdict).toBe("ask");
    expect(decision.modelCalls).toBe(0);
  });
});

describe("owner init: the reviewer authority choice", () => {
  test("keeps recommend without a terminal, and accepts a scripted choice", async () => {
    const { chooseReviewerAuthority } =
      await import("../src/cli/owner-commands");
    expect(await chooseReviewerAuthority(null)).toBe("recommend");
    const answers = ["nonsense", "routine"];
    expect(
      await chooseReviewerAuthority(async () => answers.shift() ?? ""),
    ).toBe("routine");
    expect(await chooseReviewerAuthority(async () => "")).toBe("recommend");
    expect(await chooseReviewerAuthority(async () => "delegated")).toBe(
      "delegated",
    );
    // Three invalid answers keep the default; the password is already saved.
    expect(await chooseReviewerAuthority(async () => "x")).toBe("recommend");
  });
});
