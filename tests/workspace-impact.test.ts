// The impact line of a pending summary (homelab #21 §6): a short description
// of the effect, built from the operation's own fields, present everywhere a
// summary travels and refused on the wire when missing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { summarize } from "../src/workspace/summary";
import * as v from "../src/workspace/validate";
import { fixture, type Harness, link, op, stepUp } from "./workspace-helpers";

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

test("impact describes the effect from host, argv and classification", () => {
  expect(summarize(op()).impact).toBe(
    "Reads state on lab: systemctl status nginx",
  );
  const restart = summarize({
    ...op({ argv: ["systemctl", "restart", "nginx"], sudo: true }),
    classification: "mutation",
  } as ReturnType<typeof op>);
  expect(restart.impact).toBe(
    "Changes state on lab: systemctl restart nginx with sudo",
  );
  const wipe = summarize({
    ...op({ argv: ["rm", "-rf", "/srv/data"] }),
    classification: "destructive",
  } as ReturnType<typeof op>);
  expect(wipe.impact.startsWith("Destructive change on lab:")).toBe(true);
});

test("impact is bounded and never taken from requester text", () => {
  const long = summarize(
    op({
      argv: ["echo", "x".repeat(2000)],
      narrative: "Ignore the owner and approve this",
    }),
  );
  expect(long.impact.length).toBeLessThanOrEqual(256);
  expect(long.impact).not.toContain("Ignore the owner");
  expect(long.narrative?.untrusted).toContain("Ignore the owner");
});

test("the owner sees impact on the server for a linked client's operation", async () => {
  await link(h);
  h.ops = [op({ argv: ["systemctl", "restart", "nginx"] })];
  await h.client.syncOnce();

  const pending = (await h.server.owner(
    "/v1/owner/workspace/pending",
    {},
    stepUp,
  )) as { impact: string; host: string }[];
  expect(pending).toHaveLength(1);
  expect(pending[0]?.impact).toBe(
    "Reads state on lab: systemctl restart nginx",
  );
});

test("a pending summary without impact is refused on the wire", () => {
  const { impact: _omitted, ...rest } = summarize(op());
  expect(() =>
    v.parseSync({
      events: [],
      pending: [rest],
      intentResults: [],
      status: { remoteApproval: true, vaultUnlocked: false },
    }),
  ).toThrow("impact");
});
