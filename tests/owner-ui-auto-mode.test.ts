// Owner panel: Auto Mode settings as the panel reads and sends them (homelab #21
// A1). The broker decides every change; these rules keep the form from sending
// an empty change, from showing a key, and from asking for a password it does
// not need.
import { describe, expect, test } from "bun:test";
import { OwnerApiError } from "../src/web/owner/api";
import {
  type AutoModeDraft,
  type AutoModeView,
  autoModeChange,
  draftOf,
  needsOwnerPassword,
  toAutoModeView,
} from "../src/web/owner/auto-mode-api";

const view: AutoModeView = {
  revision: 4,
  mode: "rules",
  reviewer: {
    authority: "recommend",
    fallback: "ask",
    maxRisk: "R2",
    endpoint: "https://reviewer.example.test",
    model: "reviewer-model",
    apiKeyConfigured: true,
    keySource: "vault",
    keyLocked: false,
    ready: true,
  },
};

const wire = {
  revision: 4,
  mode: "rules",
  reviewer: {
    authority: "recommend",
    fallback: "ask",
    maxRisk: "R2",
    endpoint: "https://reviewer.example.test",
    model: "reviewer-model",
    apiKeyConfigured: true,
    apiKey: { source: "vault", locked: false },
    ready: true,
  },
  choices: { modes: ["manual", "rules", "auto"], authorities: [] },
};

describe("reading the Auto Mode view", () => {
  test("accepts the documented shape and keeps only the known fields", () => {
    expect(toAutoModeView(wire)).toEqual(view);
  });

  test("a missing reviewer endpoint or model is simply absent", () => {
    const bare = {
      ...wire,
      reviewer: { ...wire.reviewer, endpoint: undefined, model: undefined },
    };
    const parsed = toAutoModeView(bare);
    expect(parsed?.reviewer.endpoint).toBeUndefined();
    expect(parsed?.reviewer.model).toBeUndefined();
  });

  test("an unknown mode, authority or missing flag is unreadable", () => {
    expect(toAutoModeView({ ...wire, mode: "yolo" })).toBeUndefined();
    expect(
      toAutoModeView({
        ...wire,
        reviewer: { ...wire.reviewer, authority: "root" },
      }),
    ).toBeUndefined();
    expect(
      toAutoModeView({
        ...wire,
        reviewer: { ...wire.reviewer, apiKeyConfigured: "yes" },
      }),
    ).toBeUndefined();
    expect(toAutoModeView(undefined)).toBeUndefined();
  });

  test("the view never carries an API key field, only whether one is configured", () => {
    const parsed = toAutoModeView({
      ...wire,
      reviewer: { ...wire.reviewer, apiKey: "sk-live-value" },
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-live-value");
    expect(parsed?.reviewer.apiKeyConfigured).toBe(true);
  });
});

describe("building a change", () => {
  test("an untouched form sends nothing", () => {
    expect(autoModeChange(view, draftOf(view))).toBeUndefined();
  });

  test("only the fields that differ are sent", () => {
    const draft: AutoModeDraft = {
      ...draftOf(view),
      mode: "manual",
    };
    expect(autoModeChange(view, draft)).toEqual({ mode: "manual" });
  });

  test("a blank endpoint or model keeps the current one", () => {
    const draft: AutoModeDraft = {
      ...draftOf(view),
      endpoint: "   ",
      model: "",
    };
    expect(autoModeChange(view, draft)).toBeUndefined();
  });

  test("a new endpoint and model are sent trimmed", () => {
    const draft: AutoModeDraft = {
      ...draftOf(view),
      endpoint: " https://new-reviewer.example.test/v1 ",
      model: "next-model",
    };
    expect(autoModeChange(view, draft)).toEqual({
      endpoint: "https://new-reviewer.example.test/v1",
      model: "next-model",
    });
  });

  test("removing the endpoint sends null, and only when one is set", () => {
    const draft: AutoModeDraft = { ...draftOf(view), clearEndpoint: true };
    expect(autoModeChange(view, draft)).toEqual({ endpoint: null });
    const none: AutoModeView = {
      ...view,
      reviewer: { ...view.reviewer, endpoint: undefined },
    };
    expect(
      autoModeChange(none, { ...draftOf(none), clearEndpoint: true }),
    ).toBeUndefined();
  });
});

describe("the password is asked for only when the broker refuses for it", () => {
  test("a 403 with the step-up wording needs the password", () => {
    expect(
      needsOwnerPassword(
        new OwnerApiError(403, 3, "Confirm with the owner password"),
      ),
    ).toBe(true);
  });

  test("a sign-in refusal, a wrong status or another 403 does not", () => {
    expect(
      needsOwnerPassword(new OwnerApiError(403, 3, "Owner sign-in required")),
    ).toBe(false);
    expect(
      needsOwnerPassword(
        new OwnerApiError(409, 4, "Confirm with the owner password"),
      ),
    ).toBe(false);
    expect(
      needsOwnerPassword(new Error("Confirm with the owner password")),
    ).toBe(false);
  });
});
