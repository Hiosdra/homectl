import { describe, expect, test } from "bun:test";
import {
  checkLengths,
  countLines,
  MAX_LINES,
} from "../scripts/check-file-length";

describe("file length rule", () => {
  test("counts lines with or without a trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  test("a new file may be exactly at the limit but not over it", () => {
    expect(checkLengths({ "src/ok.ts": MAX_LINES }, {})).toEqual([]);
    const over = checkLengths({ "src/big.ts": MAX_LINES + 1 }, {});
    expect(over.map((p) => p.file)).toEqual(["src/big.ts"]);
  });

  test("a grandfathered file may shrink but not grow", () => {
    const baseline = { "src/old.ts": 900 };
    expect(checkLengths({ "src/old.ts": 900 }, baseline)).toEqual([]);
    expect(checkLengths({ "src/old.ts": 700 }, baseline)).toEqual([]);
    const grew = checkLengths({ "src/old.ts": 901 }, baseline);
    expect(grew.map((p) => p.file)).toEqual(["src/old.ts"]);
  });

  test("a baseline entry must leave the list once back under the limit", () => {
    const problems = checkLengths(
      { "src/was-big.ts": 420 },
      { "src/was-big.ts": 900 },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("Remove the entry");
  });

  test("a baseline entry for a deleted file is reported", () => {
    const problems = checkLengths({}, { "src/gone.ts": 900 });
    expect(problems[0]?.message).toContain("no longer exists");
  });
});
