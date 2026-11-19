import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { startOwnerPanel } from "../src/web/owner/server";

const PASSWORD = "synthetic owner password";
const dir = await mkdtemp(join(tmpdir(), "hco-"));
const inventoryPath = join(dir, "inventory.yaml");
const paths = compatPaths(inventoryPath);
const oldEndpoint = process.env.HOMECTL_BROKER_ENDPOINT;
const cleanups: (() => void | Promise<void>)[] = [];

try {
  const portProbe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  const port = portProbe.port;
  portProbe.stop(true);
  if (!port) throw new Error("Could not reserve a panel port");
  const origin = `http://127.0.0.1:${port}`;
  process.env.HOMECTL_BROKER_ENDPOINT = paths.endpoint;

  await writeFile(
    inventoryPath,
    "version: 1\nmachines:\n  pc:\n    description: disposable fixture\n    transport: local\n    access: user\n",
  );
  const ran: string[][] = [];
  const daemon = await startDaemon({
    ...paths,
    mode: "compat",
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    panelOrigin: origin,
    executor: {
      run: async ({ argv }) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "fixture", stderr: "" };
      },
    },
  });
  cleanups.push(daemon.stop);
  await new FileVerifier(join(paths.state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);

  const endpoint = daemon.endpoint;
  const owner = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  const agent = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "fixture-agent",
      name: "Fixture agent",
      hosts: ["pc"],
      password: PASSWORD,
    },
    { endpoint, authorization: `Owner ${owner.token}` },
  );
  const agentOptions = { endpoint, authorization: `Bearer ${agent.token}` };
  const panel = await startOwnerPanel({ inventoryPath, port });
  cleanups.push(panel.stop);
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());

  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 800 },
    });
    try {
      await page.goto(panel.origin);

      await page.getByLabel("Owner password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(
        page.getByRole("heading", { name: "Nothing needs you" }),
      ).toBeVisible();

      const argv = [
        "systemctl",
        "--user",
        "restart",
        mobile ? "mobile-fixture" : "desktop-fixture",
      ];
      const planned = await callBroker<{ id: string; state: string }>(
        "/v1/exec",
        { host: "pc", argv },
        agentOptions,
      );
      expect(planned.state).toBe("awaiting-approval");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Approve this command?" }),
      ).toBeVisible();
      const stepUp = page.getByLabel(/owner password/i);
      if (await stepUp.count()) await stepUp.fill(PASSWORD);
      await page
        .getByRole("button", {
          name: mobile ? "Deny" : "Approve once",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Nothing needs you" }),
      ).toBeVisible();
      const finished = await callBroker<{ state: string }>(
        "/v1/wait",
        { id: planned.id, timeoutMs: 5000 },
        agentOptions,
      );
      expect(finished.state).toBe(mobile ? "denied" : "succeeded");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(
        page.getByRole("heading", { name: "Owner sign-in" }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  }
  expect(ran).toEqual([["systemctl", "--user", "restart", "desktop-fixture"]]);
  console.log("Owner panel smoke passed on desktop and mobile.");
} finally {
  try {
    for (const cleanup of cleanups.reverse()) await cleanup();
  } finally {
    if (oldEndpoint === undefined) delete process.env.HOMECTL_BROKER_ENDPOINT;
    else process.env.HOMECTL_BROKER_ENDPOINT = oldEndpoint;
    await rm(dir, { recursive: true, force: true });
  }
}
