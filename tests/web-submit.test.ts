import { expect, test } from "bun:test";
import {
  parseSavedCommandArgv,
  savedCommandConfirmation,
} from "../src/web/submit";

test("saved-command JSON argv editing preserves newlines inside arguments", () => {
  const argv = ["printf", "first line\nsecond line", "line one\nline two"];
  expect(parseSavedCommandArgv(JSON.stringify(argv, null, 2))).toEqual(argv);
});

test("saved-command confirmation shows expanded argv, host, and impact", () => {
  const confirmation = savedCommandConfirmation("nas", {
    argv: ["rm", "/srv/cache/old"],
    classification: "mutation",
    impact: "Remove expired cache files",
    needsApproval: true,
  });
  expect(confirmation.title).toContain("nas");
  expect(confirmation.body).toContain('"/srv/cache/old"');
  expect(confirmation.body).toContain("Remove expired cache files");
  expect(confirmation.body).toContain("approval required");
  expect(confirmation.body).not.toContain("{{");
});
