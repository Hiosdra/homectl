// The Windows ACL error keeps the underlying exception (0.3 acceptance). The script
// used to throw away its message, so "Cannot secure Windows permissions" told the
// owner nothing. The message now reaches the thrown error with the private path
// removed, and a sharing violation gets a bounded retry.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aclFailure, protect, windows } from "../src/platform";
import { HomectlError } from "../src/types";

test("the diagnostic keeps the exception message and flags a sharing violation", () => {
  expect(
    aclFailure(
      "IOException|0x80070020|The process cannot access the file because it is being used by another process.",
    ),
  ).toEqual({
    message:
      "IOException: The process cannot access the file because it is being used by another process.",
    transient: true,
  });
  expect(
    aclFailure("UnauthorizedAccessException|0x80070005|Access is denied."),
  ).toEqual({
    message: "UnauthorizedAccessException: Access is denied.",
    transient: false,
  });
});

test("control characters and long text are cut down; a bare type keeps its name", () => {
  const long = `IOException|0x80070002|line one\nline two\u0007${"x".repeat(400)}`;
  const { message, transient } = aclFailure(long);
  expect(message.startsWith("IOException: line one line two ")).toBe(true);
  expect(message.length).toBeLessThanOrEqual("IOException: ".length + 200);
  const codes = [...message].map((char) => char.charCodeAt(0));
  expect(codes.some((code) => code < 32 || code === 127)).toBe(false);
  expect(transient).toBe(false);
  expect(aclFailure("InvalidOperationException|0x80131509|")).toEqual({
    message: "InvalidOperationException",
    transient: false,
  });
});

test("output that is not an exception name is reported as an unknown error", () => {
  expect(aclFailure("")).toEqual({
    message: "unknown error",
    transient: false,
  });
  expect(aclFailure("C:\\Users\\someone\\secret|0x80070020|x")).toEqual({
    message: "unknown error",
    transient: false,
  });
});

test.skipIf(!windows)(
  "a failed ACL change names the exception and never the private path",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "homectl-acl-diag-"));
    const missing = join(dir, "missing-file.json");
    try {
      const error = await protect(missing).catch((failure) => failure);
      expect(error).toBeInstanceOf(HomectlError);
      expect(String(error.message)).toContain(
        "Cannot secure Windows permissions",
      );
      expect(String(error.message)).toContain("FileNotFoundException");
      expect(String(error.message)).not.toContain(missing);
      expect(String(error.message)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
