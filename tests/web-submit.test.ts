import { expect, test } from "bun:test";
import { parseSavedCommandArgv } from "../src/web/submit";

test("saved-command JSON argv editing preserves newlines inside arguments", () => {
  const argv = ["printf", "first line\nsecond line", "line one\nline two"];
  expect(parseSavedCommandArgv(JSON.stringify(argv, null, 2))).toEqual(argv);
});
