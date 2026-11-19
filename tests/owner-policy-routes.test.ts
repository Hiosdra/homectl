// Owner policy routes over a real policy file: reads change nothing, presets keep
// the rules, and removing a rule is refused without a successful step-up.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthzPolicy } from "../src/broker/authz-policy";
import { PolicyRoutes } from "../src/broker/policy-routes";
import { HomectlError } from "../src/types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-policy-routes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-19T10:00:00Z");

function setup() {
  const store = new AuthzPolicy({
    path: join(dir, "policy.json"),
    now: () => NOW,
  });
  const routes = new PolicyRoutes(store, () => NOW);
  const stepUps: unknown[] = [];
  // Mirrors the server: the password must be the owner's, or the call fails.
  const stepUp = async (password: unknown) => {
    stepUps.push(password);
    if (password !== "correct password")
      throw new HomectlError(3, "Confirm with the owner password");
  };
  const call = (path: string, input: Record<string, unknown> = {}) =>
    routes.owner(path, input, stepUp);
  return { store, call, stepUps };
}

test("reads return the policy and explain without changing it", async () => {
  const { store, call, stepUps } = setup();
  const doc = (await call("/v1/owner/policy/get")) as {
    revision: number;
    rules: { id: string }[];
  };
  expect(doc.rules.map((rule) => rule.id)).toEqual(["default-inspect"]);
  const explained = (await call("/v1/owner/policy/explain", {
    client: "codex-pc",
    host: "pc",
  })) as { rules: { ruleId: string; applies: boolean }[] };
  expect(explained.rules[0]?.applies).toBe(true);
  expect(stepUps).toHaveLength(0);
  expect((await store.document()).revision).toBe(doc.revision);
});

test("explain needs a client name", async () => {
  const { call } = setup();
  await expect(
    call("/v1/owner/policy/explain", { host: "pc" }),
  ).rejects.toThrow("client is required");
});

test("a preset changes mode and reviewer authority but keeps rules", async () => {
  const { call, stepUps } = setup();
  await expect(
    call("/v1/owner/policy/preset", { preset: "delegated", password: "wrong" }),
  ).rejects.toThrow("owner password");
  const saved = (await call("/v1/owner/policy/preset", {
    preset: "delegated",
    password: "correct password",
  })) as {
    mode: string;
    reviewer: { authority: string };
    rules: { id: string }[];
  };
  expect(saved.mode).toBe("auto");
  expect(saved.reviewer.authority).toBe("delegated");
  expect(saved.rules.map((rule) => rule.id)).toEqual(["default-inspect"]);
  expect(stepUps).toEqual(["wrong", "correct password"]);
});

test("an unknown preset is refused after the step-up", async () => {
  const { call } = setup();
  await expect(
    call("/v1/owner/policy/preset", {
      preset: "everything",
      password: "correct password",
    }),
  ).rejects.toThrow("Unknown preset");
});

test("removing a rule needs the password and removes only that rule", async () => {
  const { store, call } = setup();
  await store.save({
    version: 1,
    revision: 0,
    mode: "rules",
    reviewer: { authority: "recommend", fallback: "ask", maxRisk: "R2" },
    rules: [
      {
        id: "remembered-a1",
        effect: "allow",
        match: { clients: ["codex-pc"] },
        createdAt: NOW,
        createdBy: "owner",
      },
      {
        id: "remembered-b2",
        effect: "deny",
        match: { clients: ["codex-pc"] },
        createdAt: NOW,
        createdBy: "owner",
      },
    ],
    budgets: {
      taskMaxOperations: 50,
      taskMaxRiskPoints: 60,
      clientWindowMs: 3_600_000,
      clientMaxRiskPoints: 120,
    },
  });
  await expect(
    call("/v1/owner/policy/remove-rule", {
      id: "remembered-a1",
      password: "guess",
    }),
  ).rejects.toThrow("owner password");
  expect((await store.document()).rules).toHaveLength(2);

  const after = (await call("/v1/owner/policy/remove-rule", {
    id: "remembered-a1",
    password: "correct password",
  })) as { rules: { id: string }[] };
  expect(after.rules.map((rule) => rule.id)).toEqual(["remembered-b2"]);
});

test("removing an unknown rule is refused", async () => {
  const { call } = setup();
  await expect(
    call("/v1/owner/policy/remove-rule", {
      id: "no-such-rule",
      password: "correct password",
    }),
  ).rejects.toThrow("No rule with that id");
});

test("other paths are not policy routes", async () => {
  const { call } = setup();
  expect(await call("/v1/owner/clients/list")).toBeUndefined();
});
