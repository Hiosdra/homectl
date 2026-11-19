import { describe, expect, test } from "bun:test";
import { canaryLeaks, makeRedactor } from "../src/secrets";

// Canary only. Never a real credential. Chosen so that its base64 carries
// padding, which exercises the unpadded form too.
const CANARY = "CANARY-homectl-redact-5Rt7-do-not-leak";
const PLUS_SLASH = "CANARY>>>???~~~";

describe("canaryLeaks: encoded forms", () => {
  test("finds the raw value", () => {
    expect(canaryLeaks([`password=${CANARY}`], [CANARY])).toEqual([
      `texts[0] contains raw of values[0]`,
    ]);
  });

  test("finds URL-encoded forms", () => {
    expect(
      canaryLeaks([`q=${encodeURIComponent(PLUS_SLASH)}`], [PLUS_SLASH]),
    ).toEqual(["texts[0] contains url-encoded of values[0]"]);
  });

  test("finds padded and unpadded base64", () => {
    const base64 = Buffer.from(CANARY).toString("base64");
    expect(base64.endsWith("=")).toBe(true);
    // The unpadded form is a prefix of the padded one, so both are reported.
    expect(canaryLeaks([`token: ${base64}`], [CANARY])).toContain(
      "texts[0] contains base64 of values[0]",
    );
    const unpadded = base64.replace(/=+$/, "");
    expect(canaryLeaks([`token: ${unpadded}`], [CANARY])).toEqual([
      "texts[0] contains base64 (unpadded) of values[0]",
    ]);
  });

  test("finds base64url and hex", () => {
    const base64Url = Buffer.from(PLUS_SLASH).toString("base64url");
    expect(canaryLeaks([base64Url], [PLUS_SLASH])).toEqual([
      "texts[0] contains base64url of values[0]",
    ]);
    const hex = Buffer.from(CANARY).toString("hex");
    expect(canaryLeaks([`x=${hex}`], [CANARY])).toEqual([
      "texts[0] contains hex of values[0]",
    ]);
  });

  test("reports nothing when no form appears, and ignores empty values", () => {
    expect(canaryLeaks(["nothing to see", "more text"], [CANARY, ""])).toEqual(
      [],
    );
    expect(canaryLeaks([], [CANARY])).toEqual([]);
  });

  test("reports positions without echoing the value", () => {
    const leaks = canaryLeaks(["clean", `a ${CANARY}`], [CANARY]);
    expect(leaks).toEqual(["texts[1] contains raw of values[0]"]);
    expect(leaks.join("\n")).not.toContain(CANARY);
  });
});

describe("makeRedactor", () => {
  test("replaces raw, URL-encoded, base64 and base64url forms", () => {
    const redact = makeRedactor([CANARY, PLUS_SLASH]);
    const text = [
      `raw ${CANARY}`,
      `base64 ${Buffer.from(CANARY).toString("base64")}`,
      `url ${encodeURIComponent(PLUS_SLASH)}`,
      `base64url ${Buffer.from(PLUS_SLASH).toString("base64url")}`,
    ].join("\n");
    const redacted = redact(text);
    expect(canaryLeaks([redacted], [CANARY, PLUS_SLASH])).toEqual([]);
    expect(redacted).toContain("[REDACTED]");
  });

  test("leaves unrelated text alone", () => {
    const redact = makeRedactor([CANARY]);
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});
