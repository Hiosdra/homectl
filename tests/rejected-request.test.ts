import { expect, test } from "bun:test";
import { rejectedRequestContext } from "../src/control/rejected-request";

test("rejected control requests retain only valid redacted command context", () => {
  const context = rejectedRequestContext(
    {
      host: "lab-printer",
      operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
      argv: ["tool", "--password", "hunter2"],
    },
    2,
  );

  expect(context).toMatchObject({
    host: "lab-printer",
    operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
    argv: ["tool", "--password", "[REDACTED]"],
    policyDecision: "refused",
    reason: "request-rejected",
  });
  expect(JSON.stringify(context)).not.toContain("hunter2");
});
