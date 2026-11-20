// Owner panel: browser alerts. Each request alerts once, nothing is announced
// on the first look, alert text never carries the command, the agent's text or
// a secret, and links name a section and an id only.
import { expect, test } from "bun:test";
import {
  type Alert,
  AlertTracker,
  approvalAlert,
  secretAlert,
  workspaceApprovalAlert,
} from "../src/web/owner/alerts";

function recorder(allowed = true) {
  const shown: Alert[] = [];
  let permitted = allowed;
  const tracker = new AlertTracker(
    (alert) => shown.push(alert),
    () => permitted,
  );
  return {
    shown,
    tracker,
    allow(value: boolean) {
      permitted = value;
    },
  };
}

const op = (id: string) => ({
  id,
  client: "codex",
  host: "nas",
  argv: ["rm", "-rf", "/srv/secret-path"],
});

test("the first observation records what is pending without announcing it", () => {
  const { shown, tracker } = recorder();
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown).toEqual([]);
});

test("a request that arrives later is announced once, however often it is seen", () => {
  const { shown, tracker } = recorder();
  tracker.observe([]);
  tracker.observe([approvalAlert(op("op-1"))]);
  tracker.observe([approvalAlert(op("op-1"))]);
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown.map((alert) => alert.key)).toEqual(["approval:op-1"]);
});

test("a request that was announced is not announced again after it leaves and returns", () => {
  const { shown, tracker } = recorder();
  tracker.observe([]);
  tracker.observe([approvalAlert(op("op-1"))]);
  tracker.observe([]);
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown).toHaveLength(1);
});

test("nothing is shown while notifications are not allowed, and it is not replayed later", () => {
  const { shown, tracker, allow } = recorder(false);
  tracker.observe([]);
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown).toEqual([]);
  allow(true);
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown).toEqual([]);
});

test("a new request after permission is granted is announced", () => {
  const { shown, tracker, allow } = recorder(false);
  tracker.observe([]);
  allow(true);
  tracker.observe([secretAlert({ id: "req-1", client: "codex" })]);
  expect(shown.map((alert) => alert.key)).toEqual(["secret:req-1"]);
});

test("reset starts over: the next sign-in does not announce old requests", () => {
  const { shown, tracker } = recorder();
  tracker.observe([]);
  tracker.observe([approvalAlert(op("op-1"))]);
  tracker.reset();
  tracker.observe([approvalAlert(op("op-1"))]);
  expect(shown).toHaveLength(1);
  tracker.observe([approvalAlert(op("op-2"))]);
  expect(shown.map((alert) => alert.key)).toEqual([
    "approval:op-1",
    "approval:op-2",
  ]);
});

test("alert text never includes the command, the agent's words or the secret purpose", () => {
  const approval = approvalAlert(op("op-1"));
  const secret = secretAlert({ id: "req-1", client: "codex" });
  for (const alert of [approval, secret]) {
    expect(alert.body).not.toContain("secret-path");
    expect(alert.body).not.toContain("rm -rf");
    expect(alert.body).not.toMatch(/token|password/i);
  }
  // The assistant is named by its display name ("Codex"), never by a command.
  expect(approval.body.toLowerCase()).toContain("codex");
  expect(approval.body).toContain("nas");
});

test("links name a section and an encoded id, never a token", () => {
  expect(approvalAlert(op("op/1")).link).toBe("#/approvals/op%2F1");
  expect(secretAlert({ id: "req-1", client: "codex" }).link).toBe(
    "#/secrets/req-1",
  );
  const workspace = workspaceApprovalAlert({
    origin: "client-a",
    id: "op-1",
    originName: "Laptop",
  });
  expect(workspace.link).toBe("#/workspace");
  expect(workspace.key).toBe("workspace-approval:client-a:op-1");
});

test("workspace alerts name the linked client but not its requests", () => {
  const alert = workspaceApprovalAlert({
    origin: "client-a",
    id: "op-1",
    originName: "Laptop",
  });
  expect(alert.body).toContain("Laptop");
  expect(alert.body).not.toMatch(/argv|narrative/i);
});
