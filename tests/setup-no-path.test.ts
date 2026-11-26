import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { setup } from "../src/setup";

// Dry runs only: they list the actions and write nothing, so the real user PATH
// and home are never touched.
const PATH_ACTION = "Add CLI directory to Windows user PATH";

test("--no-path leaves the Windows user PATH out of the planned actions", async () => {
  const { actions } = await setup(homedir(), true, false);
  expect(actions).not.toContain(PATH_ACTION);
});

test("by default the PATH action is planned on Windows for the real account", async () => {
  const { actions } = await setup(homedir(), true);
  if (process.platform === "win32") expect(actions).toContain(PATH_ACTION);
  else expect(actions).not.toContain(PATH_ACTION);
});
