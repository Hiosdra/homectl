import { describe, expect, test } from "bun:test";
import {
  releaseSentence,
  type UpdateStatus,
} from "../src/web/owner/update-api";

function status(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    current: "0.3.0",
    latest: "0.2.3",
    available: false,
    signature: "unknown",
    canApply: false,
    ...overrides,
  };
}

describe("System screen release sentence", () => {
  test("a build newer than the latest release says so, not 'Latest' beside 'Installed'", () => {
    expect(releaseSentence(status({ current: "0.3.0", latest: "0.2.3" }))).toBe(
      "You have 0.3.0, a test version newer than the latest release (0.2.3).",
    );
  });

  test("the same version is up to date", () => {
    expect(releaseSentence(status({ current: "0.3.0", latest: "0.3.0" }))).toBe(
      "You are up to date. The latest release is 0.3.0.",
    );
  });

  test("an older build with a newer release says an update is available", () => {
    expect(
      releaseSentence(
        status({ current: "0.2.3", latest: "0.3.1", available: true }),
      ),
    ).toBe("Version 0.3.1 is available.");
  });

  test("with no release reported, it says so plainly", () => {
    expect(releaseSentence(status({ latest: undefined }))).toBe(
      "Could not check for a newer release.",
    );
  });

  test("an unparseable version is shown as the latest release, not compared", () => {
    expect(releaseSentence(status({ current: "dev", latest: "0.2.3" }))).toBe(
      "The latest release is 0.2.3.",
    );
  });
});
