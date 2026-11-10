// Two disposable peers exercise the browser flow over the real encrypted peer transport.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadInventory, saveInventory } from "../src/inventory";
import { defaults } from "../src/peer/store";
import { serve } from "../src/serve";
import { keyReference } from "../src/session/keys";

const root = await mkdtemp(join(tmpdir(), "homectl-sync-e2e-"));
const peers: Awaited<ReturnType<typeof serve>>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  async function makePeer(name: string) {
    const inventory = join(root, name, "inventory.yaml");
    await saveInventory(inventory, {
      version: 1,
      session: { ttl: "24h", database: join(root, name, "vault.kdbx") },
      machines: {},
    });
    const running = await serve({
      inventoryPath: inventory,
      configPath: `${inventory}.ssh_config`,
      port: 0,
      peerPort: 0,
      interface: "127.0.0.1",
      discover: false,
    });
    peers.push(running);
    running.hub.state.name = name;
    await running.hub.save();
    return { running, inventory };
  }
  const source = await makePeer("Source");
  const target = await makePeer("Target");
  const password = "temporary-test-password";
  const secret = "temporary-synthetic-secret-not-for-ui";
  await source.running.hub.vault.unlock(password, true);
  await target.running.hub.vault.unlock(password, true);
  const key = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  await source.running.hub.vault.apply({
    "homectl-testhost": {
      title: "homectl-testhost",
      fields: { Title: "homectl-testhost", Password: secret },
      attachments: { id_ed25519: Buffer.from(key).toString("base64") },
    },
  });
  await saveInventory(source.inventory, {
    version: 1,
    session: { ttl: "24h", database: source.running.hub.vault.path },
    machines: {
      testhost: {
        description: "Test host",
        transport: "ssh",
        address: "192.0.2.55",
        user: "operator",
        ssh_alias: "testhost",
        access: "observe",
        auth: keyReference("testhost", source.inventory),
      },
    },
  });
  await source.running.hub.snapshot();
  source.running.hub.vault.lock();
  await source.running.hub.openPair();
  await target.running.hub.join(
    source.running.address,
    source.running.hub.pair?.code ?? "",
  );
  await source.running.hub.confirm(defaults());
  await target.running.hub.confirm(defaults());
  await target.running.hub.pollPair();
  const launch = JSON.parse(await readFile(target.running.launch, "utf8"));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOMECTL_BROWSER_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  let applyRequests = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/sync/apply") applyRequests++;
  });
  await page.goto(`${launch.url}/#token=${encodeURIComponent(launch.token)}`);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByRole("button", { name: "Compare and sync" }).click();
  await expect(page.locator("#sync-wait-title")).toContainText("Source");
  await expect(page.locator("#sync-form button.primary")).toBeDisabled();
  await expect(page.locator("#sync-wait-status")).toContainText(
    "automatically",
  );
  expect(applyRequests).toBe(0);
  const fallback = await page.evaluate(async () => {
    const state = await (await fetch("/api/state")).json();
    const result = await fetch("/api/sync/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.pending[0].id, choices: {} }),
    });
    return { status: result.status, body: await result.json() };
  });
  expect(fallback.status).toBe(409);
  expect(fallback.body.error).toContain("other device's vault was locked");
  applyRequests = 0;
  await source.running.hub.vault.unlock(password);
  await expect(page.locator("#notice")).toContainText(
    "other vault is unlocked",
    { timeout: 20_000 },
  );
  await expect(page.locator("#sync-wait-title")).toHaveCount(0);
  await expect(page.locator("#sync-form button.primary")).toBeEnabled();
  await expect(page.locator("body")).not.toContainText(secret);
  expect(applyRequests).toBe(0);
  expect(
    (await loadInventory(target.inventory)).machines.testhost,
  ).toBeUndefined();
  console.log(
    "Real peer sync UI smoke passed: unlock detected, preview refreshed, no automatic apply or secret displayed.",
  );
} finally {
  await browser?.close();
  for (const peer of peers.reverse()) await peer.stop();
  await rm(root, { recursive: true, force: true });
}
