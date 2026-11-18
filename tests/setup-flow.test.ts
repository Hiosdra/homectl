import { expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectLanInterface, setupFlow } from "../src/setup-flow";

test("interactive LAN selection auto-selects one address and prompts for several", async () => {
  let prompts = 0;
  expect(
    await selectLanInterface(undefined, ["192.0.2.10"], async () => {
      prompts++;
      return "1";
    }),
  ).toBe("192.0.2.10");
  expect(prompts).toBe(0);
  expect(
    await selectLanInterface(
      undefined,
      ["192.0.2.10", "198.51.100.20"],
      async (prompt) => {
        prompts++;
        expect(prompt).toBe("Interface number: ");
        return "2";
      },
    ),
  ).toBe("198.51.100.20");
  expect(prompts).toBe(1);
});

test("JSON setup dry-run never prompts or creates installation files", async () => {
  const home = await mkdtemp(join(tmpdir(), "homectl-setup-flow-"));
  try {
    const result = await setupFlow({
      home,
      json: true,
      dryRun: true,
      installDeps: false,
      configureFirewall: false,
    });
    expect(result.interactive).toBe(false);
    expect(result.firewall).toMatchObject({ configured: false });
    await expect(access(join(home, ".config", "homectl"))).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("noninteractive firewall configuration requires an explicit LAN", async () => {
  const home = await mkdtemp(join(tmpdir(), "homectl-setup-firewall-"));
  try {
    await expect(
      setupFlow({
        home,
        json: true,
        dryRun: false,
        installDeps: false,
        configureFirewall: true,
      }),
    ).rejects.toThrow("requires --interface");
    expect(await readdir(home)).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("interactive firewall setup refuses an empty or skipped LAN choice before setup", async () => {
  for (const [addresses, answer] of [
    [[], "1"],
    [["192.0.2.10", "198.51.100.20"], ""],
  ] as const) {
    const home = await mkdtemp(
      join(tmpdir(), "homectl-setup-firewall-prompt-"),
    );
    try {
      await expect(
        setupFlow({
          home,
          json: false,
          dryRun: false,
          installDeps: false,
          configureFirewall: true,
          interactive: true,
          addresses: [...addresses],
          ask: async () => answer,
        }),
      ).rejects.toThrow(
        "Choose a LAN interface before configuring the firewall",
      );
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
