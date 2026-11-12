import { describe, expect, test } from "bun:test";
import { idleSeconds } from "../src/session/config";

describe("panel idle time", () => {
  test("accepts durations of at least one minute", () => {
    expect(idleSeconds("2h")).toBe(7200);
    expect(idleSeconds("1m")).toBe(60);
  });

  test("refuses shorter durations and the reboot-only value", () => {
    expect(() => idleSeconds("30s")).toThrow("at least 1m");
    expect(() => idleSeconds("until-reboot")).toThrow("at least 1m");
    expect(() => idleSeconds("soon")).toThrow();
  });
});
