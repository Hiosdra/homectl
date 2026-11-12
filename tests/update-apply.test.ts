import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process";
import { installRelease, systemTar } from "../src/update-apply";
import { handleUpdateRoute } from "../src/web/update-status";

const windows = process.platform === "win32";

// The route answers only for the panel on this computer, and only from its own origin.
describe("update apply route", () => {
  const checker = {
    status: async () => ({
      current: "0.2.0",
      latest: "0.2.1",
      available: true,
    }),
  } as never;
  const post = (address: string, origin?: string) =>
    handleUpdateRoute(
      new Request(`${address}/api/update/apply`, {
        method: "POST",
        headers: origin ? { Origin: origin } : {},
      }),
      new URL(`${address}/api/update/apply`),
      checker,
    );

  test("refuses the apply from a LAN address, as a container or LAN panel would be", async () => {
    const response = await post(
      "http://192.0.2.10:7447",
      "http://192.0.2.10:7447",
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toContain("redeploying its image");
  });

  test("refuses a cross-origin apply on this computer", async () => {
    const response = await post("http://127.0.0.1:7447", "http://evil.example");
    expect(response?.status).toBe(403);
  });

  test("says so when no newer release is available", async () => {
    const none = {
      status: async () => ({ current: "0.2.0", available: false }),
    } as never;
    const response = await handleUpdateRoute(
      new Request("http://127.0.0.1:7447/api/update/apply", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:7447" },
      }),
      new URL("http://127.0.0.1:7447/api/update/apply"),
      none,
    );
    expect(response?.status).toBe(409);
  });

  test("leaves other requests alone", async () => {
    const response = await handleUpdateRoute(
      new Request("http://127.0.0.1:7447/api/state"),
      new URL("http://127.0.0.1:7447/api/state"),
      checker,
    );
    expect(response).toBeUndefined();
  });
});

describe.skipIf(!windows)("Windows release install", () => {
  const roots: string[] = [];
  const temp = async (prefix: string) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };

  // A release archive built the way the release pipeline builds it, with its checksum line.
  async function fakeRelease(version: string, exeBody: string) {
    const work = await temp("homectl-release-");
    const folder = `homectl-${version}-windows-x64`;
    await mkdir(join(work, folder));
    await writeFile(join(work, folder, "homectl.exe"), exeBody);
    const zip = join(work, `${folder}.zip`);
    const made = Bun.spawn([
      systemTar(),
      "-a",
      "-c",
      "-f",
      zip,
      "-C",
      work,
      folder,
    ]);
    await made.exited;
    expect(made.exitCode).toBe(0);
    const bytes = new Uint8Array(
      await Bun.file(zip).arrayBuffer(),
    ) as Uint8Array<ArrayBuffer>;
    const sum = createHash("sha256").update(bytes).digest("hex");
    return { folder, bytes, sums: `${sum}  ${folder}.zip\n` };
  }

  // The running release and the command files that point at it, as installed by hand.
  async function installedRelease() {
    const root = await temp("homectl-install-");
    const home = join(root, "home");
    const oldFolder = join(
      root,
      "share",
      "homectl",
      "0.2.0",
      "homectl-0.2.0-windows-x64",
    );
    await mkdir(oldFolder, { recursive: true });
    await writeFile(join(oldFolder, "homectl.exe"), "old");
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const exe = join(oldFolder, "homectl.exe");
    await writeFile(join(bin, "homectl.cmd"), `@echo off\n"${exe}" %*\n`);
    await writeFile(
      join(bin, "homectl"),
      `#!/bin/sh\nexec "${exe.replaceAll("\\", "/")}" "$@"\n`,
    );
    return { root, home, oldFolder, bin, exe };
  }

  const fetcherFor =
    (release: { bytes: Uint8Array; sums: string }) => async (url: string) =>
      new Response(
        url.endsWith("SHA256SUMS")
          ? release.sums
          : new Blob([release.bytes.slice()]),
      );

  // Only the archive is unpacked for real; the new program is not started by the test.
  const runner = async (spec: { argv: string[] }) =>
    spec.argv[0] === systemTar()
      ? run(spec as never)
      : { stdout: "", stderr: "", exitCode: 0 };

  test("installs beside the running release, points the commands at it, and keeps the old one", async () => {
    const release = await fakeRelease("9.9.9", "new");
    const installed = await installedRelease();
    const result = await installRelease("v9.9.9", {
      platform: "win32",
      arch: "x64",
      execPath: installed.exe,
      home: installed.home,
      fetcher: fetcherFor(release),
      runner,
    });
    expect(result.version).toBe("9.9.9");
    const newExe = join(
      installed.root,
      "share",
      "homectl",
      "9.9.9",
      release.folder,
      "homectl.exe",
    );
    expect(await readFile(newExe, "utf8")).toBe("new");
    expect(await readFile(installed.exe, "utf8")).toBe("old");
    const cmd = await readFile(join(installed.bin, "homectl.cmd"), "utf8");
    const sh = await readFile(join(installed.bin, "homectl"), "utf8");
    expect(cmd).toContain("9.9.9");
    expect(cmd).not.toContain("0.2.0");
    expect(sh).toContain("9.9.9");
    expect(
      existsSync(join(installed.bin, "homectl.cmd.before-update.bak")),
    ).toBe(true);
  });

  test("a checksum mismatch installs nothing", async () => {
    const release = await fakeRelease("9.9.8", "new");
    const installed = await installedRelease();
    const tampered = {
      bytes: release.bytes,
      sums: `${"0".repeat(64)}  ${release.folder}.zip\n`,
    };
    await expect(
      installRelease("v9.9.8", {
        platform: "win32",
        arch: "x64",
        execPath: installed.exe,
        home: installed.home,
        fetcher: fetcherFor(tampered),
        runner,
      }),
    ).rejects.toThrow("does not match its checksum");
    expect(existsSync(join(installed.root, "share", "homectl", "9.9.8"))).toBe(
      false,
    );
    expect(
      await readFile(join(installed.bin, "homectl.cmd"), "utf8"),
    ).toContain("0.2.0");
  });

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
});
