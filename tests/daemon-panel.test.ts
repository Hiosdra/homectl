import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonWithPanel } from "../src/broker/daemon-panel";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";

test("the daemon serves the owner panel and closes it on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-daemon-panel-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port as number;
  probe.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const inventoryPath = join(dir, "inventory.yaml");
  const paths = compatPaths(inventoryPath);
  const password = "owner password for tests";
  let stop: (() => Promise<void>) | undefined;
  try {
    await writeFile(inventoryPath, "version: 1\nmachines: {}\n");
    const daemon = await startDaemonWithPanel(
      {
        mode: "hardened",
        ...paths,
        inventoryPath,
        sshConfigPath: join(dir, "ssh_config"),
      },
      { port },
    );
    stop = daemon.stop;
    expect(daemon.endpoint.panel).toBe(origin);
    expect((await fetch(origin)).status).toBe(200);
    await new FileVerifier(join(paths.state, "owner.json"), {
      iterations: 1,
      memorySize: 1024,
      parallelism: 1,
    }).set(password);
    const login = await fetch(`${origin}/v1/owner/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    await stop();
    stop = undefined;
    expect(await Bun.file(paths.endpoint).exists()).toBe(false);
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
  } finally {
    await stop?.();
    await rm(dir, { recursive: true, force: true });
  }
});
