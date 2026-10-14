import { expect, test } from "bun:test";
import { installDependencies } from "../src/dependencies";
import type { Runner } from "../src/types";

const never: Runner = async () => {
  throw new Error("must not run");
};
test("dependency dry-run never installs or elevates", async () => {
  const result = await installDependencies(true, never, () => false, true);
  expect(result.actions).toHaveLength(2);
});
test("installed dependencies cause no installer process", async () => {
  expect(
    (await installDependencies(false, never, () => true, true)).installed,
  ).toBe(false);
});
test("missing winget stops before elevation", async () => {
  await expect(
    installDependencies(false, never, () => false, true),
  ).rejects.toThrow("App Installer");
});
test("cancelled elevation stops before KeePass installer", async () => {
  let calls = 0;
  await expect(
    installDependencies(
      false,
      async () => {
        calls++;
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      (name) => name === "winget",
      true,
    ),
  ).rejects.toThrow("UAC was cancelled");
  expect(calls).toBe(1);
});
test("successful installation is checked again", async () => {
  let installed = false;
  const result = await installDependencies(
    false,
    async ({ argv }) => {
      expect(argv[0]).toBe("winget");
      installed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    (name) => name !== "keepassxc-cli" || installed,
    true,
  );
  expect(result.checks?.every((c) => c.ok)).toBe(true);
});
test("Linux gets package manager guidance without mutations", async () => {
  await expect(
    installDependencies(false, never, () => false, false),
  ).rejects.toThrow("Linux/WSL");
});

test("Windows environment casing preserves PATH and SystemRoot for subprocesses", async () => {
  const { cleanEnv } = await import("../src/credentials");
  const env = cleanEnv({
    Path: "C:\\Windows",
    SYSTEMROOT: "C:\\Windows",
    PROGRAMDATA: "C:\\ProgramData",
    secret: "hidden",
  });
  expect(env.PATH).toBe("C:\\Windows");
  expect(env.SystemRoot).toBe("C:\\Windows");
  expect(env.ProgramData).toBe("C:\\ProgramData");
  expect(env.secret).toBeUndefined();
});
