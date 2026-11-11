import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { service } from "../src/service";
import {
  LAUNCH_LABEL,
  launchdPaths,
  launchdPlist,
} from "../src/service-launchd";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function homeDirectory() {
  const home = await mkdtemp(join(tmpdir(), "homectl-launchd-"));
  cleanup.push(home);
  return home;
}

describe("macOS LaunchAgent", () => {
  test("the plist runs serve at login, restarts it on failure and keeps files private", () => {
    const text = launchdPlist(
      "/Users/me/homelab/inventory.yaml",
      "192.168.1.20",
      "/Users/me/Library/Logs/homectl.log",
    );
    expect(text).toContain(`<string>${LAUNCH_LABEL}</string>`);
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>SuccessfulExit</key><false/>");
    expect(text).toContain("<key>umask</key><integer>63</integer>");
    expect(text).toContain("<string>serve</string>");
    expect(text).toContain("<string>/Users/me/homelab/inventory.yaml</string>");
    expect(text).toContain("<string>192.168.1.20</string>");
  });

  test("values are XML-escaped", () => {
    const text = launchdPlist(
      "/tmp/a&b <c>/inventory.yaml",
      "127.0.0.1",
      "/tmp/log",
    );
    expect(text).toContain(
      "<string>/tmp/a&amp;b &lt;c&gt;/inventory.yaml</string>",
    );
    expect(text).not.toContain("a&b <c>");
  });

  test("paths live in the user's LaunchAgents and Logs folders", () => {
    const paths = launchdPaths("/Users/me");
    expect(paths.plist).toBe(
      join("/Users/me", "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`),
    );
    expect(paths.log).toBe(join("/Users/me", "Library", "Logs", "homectl.log"));
  });

  test("a dry run on macOS previews the agent path without changing anything", async () => {
    const home = await homeDirectory();
    const result = await service("install", {
      inventory: "/Users/me/homelab/inventory.yaml",
      interface: "192.168.1.20",
      home,
      platform: "darwin",
      dryRun: true,
    });
    expect(result).toMatchObject({
      action: "install",
      platform: "darwin",
      credentialAccess: false,
    });
    expect(await Bun.file(launchdPaths(home).plist).exists()).toBe(false);
  });

  test("an existing agent is never overwritten", async () => {
    const home = await homeDirectory();
    const paths = launchdPaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(paths.plist, "keep me");
    await expect(
      service("install", {
        inventory: "/Users/me/homelab/inventory.yaml",
        interface: "192.168.1.20",
        home,
        platform: "darwin",
      }),
    ).rejects.toThrow("already exists");
    expect(await Bun.file(paths.plist).text()).toBe("keep me");
  });

  test("unknown actions are refused on macOS too", async () => {
    const home = await homeDirectory();
    await expect(
      service("explode", {
        inventory: "/x/inventory.yaml",
        home,
        platform: "darwin",
        dryRun: true,
      }),
    ).rejects.toThrow("Use service install");
  });
});
