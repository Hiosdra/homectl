// Tests for the hardened Windows service installation plan, config format,
// SID-based ACL steps (language-independent), and native C# host compilation.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlan, uninstallPlan } from "../src/broker/install";
import {
  buildWindowsElevationScript,
  windowsElevationNotice,
} from "../src/broker/install-windows";
import {
  serializeWindowsServiceConfig,
  WINDOWS_SERVICE_ACCOUNT,
  WINDOWS_SERVICE_HOST_CS,
  WINDOWS_SERVICE_NAME,
  windowsCscPath,
} from "../src/broker/windows-service-host";

describe("Windows hardened service install plan", () => {
  test("produces a supported plan using virtual service account and SID ACLs", () => {
    const plan = installPlan({
      platform: "win32",
      executable: ["C:\\Users\\owner\\.local\\bin\\home-ctl.exe"],
      workspace: "C:\\Users\\owner\\.config\\homectl",
      systemd: false,
      cscAvailable: true,
    });
    expect(plan.supported).toBe(true);
    expect(plan.reasons).toEqual([]);
    expect(plan.steps.length).toBeGreaterThan(10);

    const flat = plan.steps.map((s) => s.argv.join(" "));
    // Copies compiled binary into admin-only bin folder.
    expect(
      plan.steps.some((s) => s.description.includes("Copy homectl binary")),
    ).toBe(true);
    // Compiles native ServiceBase host with csc.exe.
    expect(
      flat.some(
        (cmd) =>
          cmd.includes("csc.exe") &&
          cmd.includes("/reference:System.ServiceProcess.dll"),
      ),
    ).toBe(true);
    // Registers service under NT SERVICE\homectl with unrestricted SID type.
    expect(
      flat.some(
        (cmd) =>
          cmd.includes(`sc.exe create ${WINDOWS_SERVICE_NAME}`) &&
          cmd.includes(WINDOWS_SERVICE_ACCOUNT),
      ),
    ).toBe(true);
    expect(
      flat.some((cmd) =>
        cmd.includes(`sc.exe sidtype ${WINDOWS_SERVICE_NAME} unrestricted`),
      ),
    ).toBe(true);
    // Uses well-known SIDs (*S-1-5-18, *S-1-5-32-544, *S-1-5-32-545) instead of
    // English group names so ACLs succeed on non-English Windows locales, and
    // sets ownership with icacls /setowner (which enables SeRestorePrivilege).
    expect(
      flat.some(
        (cmd) =>
          cmd.includes("icacls.exe") &&
          cmd.includes("*S-1-5-18") &&
          cmd.includes("*S-1-5-32-544"),
      ),
    ).toBe(true);
    expect(
      flat.some(
        (cmd) =>
          cmd.includes("icacls.exe") &&
          cmd.includes(`/setowner ${WINDOWS_SERVICE_ACCOUNT}`),
      ),
    ).toBe(true);
    // Ends by starting the service.
    expect(plan.steps.at(-1)?.argv).toEqual([
      "sc.exe",
      "start",
      WINDOWS_SERVICE_NAME,
    ]);
  });

  test("refuses cleanly when .NET Framework csc.exe is missing", () => {
    const plan = installPlan({
      platform: "win32",
      executable: ["C:\\home-ctl.exe"],
      workspace: "C:\\ws",
      systemd: false,
      cscAvailable: false,
    });
    expect(plan.supported).toBe(false);
    expect(plan.reasons[0]).toContain("csc.exe");
  });

  test("uninstall plan stops and deletes service while preserving state", () => {
    const steps = uninstallPlan("win32");
    expect(steps.map((s) => s.argv.slice(0, 3))).toContainEqual([
      "sc.exe",
      "stop",
      WINDOWS_SERVICE_NAME,
    ]);
    expect(steps.map((s) => s.argv.slice(0, 3))).toContainEqual([
      "sc.exe",
      "delete",
      WINDOWS_SERVICE_NAME,
    ]);
    expect(
      steps.some((s) => s.description.includes("broker state is preserved")),
    ).toBe(true);
  });

  test("serializes service.conf with CRLF lines", () => {
    const text = serializeWindowsServiceConfig({
      executable: "C:\\ProgramData\\homectl\\bin\\home-ctl.exe",
      args: ["daemon", "run", "--mode", "hardened"],
      state: "C:\\ProgramData\\homectl\\state",
      endpoint: "C:\\ProgramData\\homectl\\endpoint.json",
      panelOrigin: "http://127.0.0.1:7451",
      log: "C:\\ProgramData\\homectl\\state\\service.log",
    });
    expect(text).toContain(
      "executable=C:\\ProgramData\\homectl\\bin\\home-ctl.exe\r\n",
    );
    expect(text).toContain(
      "arg=daemon\r\narg=run\r\narg=--mode\r\narg=hardened\r\n",
    );
    expect(text).toContain("panelOrigin=http://127.0.0.1:7451\r\n");
  });

  test("builds UAC elevation script with quoted argv and error pause", () => {
    const script = buildWindowsElevationScript([
      "C:\\Users\\o'connor\\home-ctl.exe",
      "daemon",
      "install",
      "--inventory",
      "C:\\Users\\o'connor\\.config\\homectl\\inventory.yaml",
    ]);
    expect(script).toContain("'C:\\Users\\o''connor\\home-ctl.exe'");
    expect(script).toContain("'daemon', 'install', '--inventory'");
    expect(script).toContain("if ($code -ne 0)");
    expect(script).toContain("exit $code");
  });

  test("explains why administrator permission is needed once before UAC", () => {
    const installNote = windowsElevationNotice("install");
    expect(installNote).toContain(WINDOWS_SERVICE_ACCOUNT);
    expect(installNote).toContain("needed once");
    expect(installNote).toContain("not as an administrator");
    const uninstallNote = windowsElevationNotice("uninstall");
    expect(uninstallNote).toContain("will be kept");
  });

  test("compiles WINDOWS_SERVICE_HOST_CS cleanly on Windows", async () => {
    if (process.platform !== "win32") return;
    const csc = windowsCscPath();
    if (!(await Bun.file(csc).exists())) return;
    const dir = await mkdtemp(join(tmpdir(), "homectl-win-svc-"));
    try {
      const src = join(dir, "homectl-service.cs");
      const exe = join(dir, "homectl-service.exe");
      await writeFile(src, WINDOWS_SERVICE_HOST_CS, "utf8");
      const proc = Bun.spawnSync(
        [
          csc,
          "/nologo",
          "/warnaserror+",
          "/target:exe",
          "/optimize+",
          "/reference:System.ServiceProcess.dll",
          `/out:${exe}`,
          src,
        ],
        { stdout: "pipe", stderr: "pipe", windowsHide: true },
      );
      expect(proc.exitCode).toBe(0);
      expect(await Bun.file(exe).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
