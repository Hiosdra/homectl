// The guided setup in the owner panel, as pure logic: the hash routes, the first-run
// rule (Welcome opens by itself only on a fresh broker and never over another
// section), the state words and the progress line, the example prompts, and the copy
// that an owner reads (no developer words in it).
import { describe, expect, test } from "bun:test";
import { parseRoute, setupHash } from "../src/web/owner/route";
import { autoOpenTarget } from "../src/web/owner/setup-first-run";
import type { SetupStatus, SetupStep } from "../src/web/owner/setup-api";
import {
  firstOpenStep,
  progressLine,
  stateWord,
  UPGRADE_LINE,
  WIZARD_STEPS,
} from "../src/web/owner/setup-copy";
import { promptsFor } from "../src/web/owner/setup-steps";

function status(over: Partial<SetupStatus> = {}): SetupStatus {
  return {
    welcomed: false,
    completed: false,
    dismissed: false,
    path: null,
    steps: [],
    next: "vault",
    counts: { required: 5, requiredDone: 0, optional: 2, optionalDone: 0 },
    facts: {
      vault: false,
      machines: 0,
      readyMachines: 0,
      assistants: 0,
      connectedAssistants: 0,
      requests: 0,
      resolvedApprovals: 0,
      permissionsRevision: 0,
      workspaceServer: false,
      pairedDevices: 0,
    },
    ...over,
  };
}

describe("hash routes", () => {
  test("the setup opens at its start and at a named step", () => {
    expect(parseRoute("#/setup")).toEqual({ name: "setup", step: "" });
    expect(parseRoute("#/setup/machine")).toEqual({
      name: "setup",
      step: "machine",
    });
    expect(setupHash()).toBe("#/setup");
    expect(setupHash("first-request")).toBe("#/setup/first-request");
  });

  test("other sections keep their routes", () => {
    expect(parseRoute("#/approvals/abc")).toEqual({
      name: "approval",
      id: "abc",
    });
    expect(parseRoute("#/")).toEqual({ name: "overview" });
  });
});

describe("the first-run rule", () => {
  test("a fresh broker opens at Welcome on the first sign-in", () => {
    expect(autoOpenTarget(status(), "")).toBe("#/setup/welcome");
    expect(autoOpenTarget(status(), "#/")).toBe("#/setup/welcome");
  });

  test("another section that was asked for is never replaced", () => {
    expect(autoOpenTarget(status(), "#/approvals/abc")).toBeUndefined();
    expect(autoOpenTarget(status(), "#/machines")).toBeUndefined();
  });

  test("it does not open again once Welcome was seen or setup is complete", () => {
    expect(autoOpenTarget(status({ welcomed: true }), "")).toBeUndefined();
    expect(autoOpenTarget(status({ completed: true }), "")).toBeUndefined();
  });

  test("it waits for the status", () => {
    expect(autoOpenTarget(undefined, "")).toBeUndefined();
  });
});

describe("state words and progress", () => {
  const step = (over: Partial<SetupStep>): SetupStep => ({
    id: "vault",
    required: true,
    detected: false,
    stored: null,
    state: "open",
    ...over,
  });

  test("done, skipped, optional, next and to do", () => {
    expect(stateWord(step({ state: "done" }), null)).toBe("Done");
    expect(stateWord(step({ state: "skipped" }), "vault")).toBe("Skipped");
    expect(stateWord(step({ id: "devices", required: false }), "vault")).toBe(
      "Optional",
    );
    expect(stateWord(step({ id: "vault" }), "vault")).toBe("Next");
    expect(stateWord(step({ id: "machine" }), "vault")).toBe("To do");
  });

  test("the progress line says what is needed and what is optional", () => {
    expect(progressLine(status())).toBe("0 of 5 needed · 0 of 2 optional");
    expect(
      progressLine(
        status({
          counts: {
            required: 5,
            requiredDone: 2,
            optional: 2,
            optionalDone: 1,
          },
        }),
      ),
    ).toBe("2 of 5 needed · 1 of 2 optional");
  });

  test("the first open step follows the wizard, then the next required step", () => {
    expect(firstOpenStep(status())).toBe("welcome");
    expect(firstOpenStep(status({ welcomed: true }))).toBe("vault");
    expect(firstOpenStep(status({ welcomed: true, completed: true }))).toBe(
      "done",
    );
  });
});

describe("the wizard", () => {
  test("it has the nine steps in order, with welcome first and done last", () => {
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
      "welcome",
      "vault",
      "machine",
      "assistant",
      "first-request",
      "permissions",
      "devices",
      "notifications",
      "done",
    ]);
  });

  test("the example prompts name the machine and ask for an approval", () => {
    const prompts = promptsFor("nas");
    expect(prompts.readOnly).toContain("nas");
    expect(prompts.readOnly.toLowerCase()).toContain("read-only");
    expect(prompts.change).toContain("nas");
    expect(prompts.change).toContain("approve");
    expect(promptsFor("").change).toContain("<your machine>");
  });

  test("the words an owner reads avoid developer terms", () => {
    const words = [
      ...WIZARD_STEPS.flatMap((step) => [step.title, step.line]),
      UPGRADE_LINE,
    ].join(" ");
    for (const term of ["argv", "daemon", "kdbx", "uname", "digest", "JSON"])
      expect(words).not.toContain(term);
  });
});
