import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFlow } from "../src/setup-flow";

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
  await expect(
    setupFlow({
      home: tmpdir(),
      json: true,
      dryRun: true,
      installDeps: false,
      configureFirewall: true,
    }),
  ).rejects.toThrow("requires --interface");
});
