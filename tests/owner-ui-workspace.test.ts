// Owner panel: the workspace and system view models (what the buttons offer and
// how the update status is read). These rules are the panel's side of the
// server's own checks; the server still refuses what the panel hides.
import { expect, test } from "bun:test";
import { parseRoute } from "../src/web/owner/route";
import { signatureLabel, toUpdateStatus } from "../src/web/owner/update-api";
import {
  decisionKey,
  decisionOffer,
  type WorkspaceClient,
} from "../src/web/owner/workspace-api";

const linked = { remoteApproval: true } as Pick<
  WorkspaceClient,
  "remoteApproval"
>;
const unlinked = { remoteApproval: false } as Pick<
  WorkspaceClient,
  "remoteApproval"
>;

test("a normal operation offers approve and deny on the server", () => {
  expect(decisionOffer({ stepUp: false }, linked)).toEqual({
    approve: true,
    deny: true,
  });
});

test("a step-up operation offers no approve button, only deny with a note", () => {
  const offer = decisionOffer({ stepUp: true }, linked);
  expect(offer.approve).toBe(false);
  expect(offer.deny).toBe(true);
  expect(offer.note).toContain("Approve it on its own device");
});

test("a client that does not accept remote approvals offers no decision", () => {
  const offer = decisionOffer({ stepUp: false }, unlinked);
  expect(offer.approve).toBe(false);
  expect(offer.deny).toBe(false);
  expect(offer.note).toContain("Decide on its own device");
});

test("an operation whose client is gone offers no decision", () => {
  const offer = decisionOffer({ stepUp: false }, undefined);
  expect(offer.approve).toBe(false);
  expect(offer.deny).toBe(false);
});

test("decision keys combine the linked client and the operation id", () => {
  expect(decisionKey("client-a", "op-1")).toBe("client-a:op-1");
  expect(decisionKey("client-a", "op-1")).not.toBe(
    decisionKey("client-b", "op-1"),
  );
});

test("the update status accepts only the documented shape", () => {
  expect(
    toUpdateStatus({
      current: "0.3.0",
      latest: "0.3.1",
      available: true,
      signature: "verified",
      canApply: true,
    }),
  ).toEqual({
    current: "0.3.0",
    latest: "0.3.1",
    available: true,
    signature: "verified",
    canApply: true,
  });
  expect(toUpdateStatus({ latest: "0.3.1" })).toBeUndefined();
  expect(toUpdateStatus("0.3.0")).toBeUndefined();
  expect(toUpdateStatus(null)).toBeUndefined();
});

test("an unknown signature state is shown as unknown, never as verified", () => {
  const status = toUpdateStatus({
    current: "0.3.0",
    signature: "maybe",
    canApply: true,
  });
  expect(status?.signature).toBe("unknown");
  expect(status?.canApply).toBe(true);
});

test("an update is available only with a reported latest version", () => {
  const status = toUpdateStatus({
    current: "0.3.0",
    available: true,
    canApply: true,
  });
  expect(status?.available).toBe(false);
  expect(status?.latest).toBeUndefined();
});

test("a version string that is absurdly long is refused", () => {
  expect(toUpdateStatus({ current: "x".repeat(65) })).toBeUndefined();
});

test("signature states have distinct labels and tones", () => {
  expect(signatureLabel("verified")).toEqual({
    text: "Signature verified",
    tone: "good",
  });
  expect(signatureLabel("failed").tone).toBe("bad");
  expect(signatureLabel("unverified").tone).toBe("warn");
  expect(signatureLabel("unknown").text).toBe("Signature status unknown");
});

test("hash routes name the workspace and system sections", () => {
  expect(parseRoute("#/workspace")).toEqual({ name: "workspace" });
  expect(parseRoute("#/system")).toEqual({ name: "system" });
  expect(parseRoute("#/approvals/op-1")).toEqual({
    name: "approval",
    id: "op-1",
  });
  expect(parseRoute("#/nope")).toEqual({ name: "overview" });
});
