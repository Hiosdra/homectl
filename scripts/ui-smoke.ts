// Disposable synthetic workspace. Never reads the owner's homectl database.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { saveInventory } from "../src/inventory";
import { serve } from "../src/serve";
import { keyReference } from "../src/session/keys";

const root = await mkdtemp(join(tmpdir(), "hcui-"));
const inventory = join(root, "inventory.yaml");
await saveInventory(inventory, {
  version: 1,
  session: { ttl: "24h", database: join(root, "homelab.kdbx") },
  machines: {
    "agent-host": {
      description: "Local device · demonstration data",
      transport: "local",
      access: "user",
    },
    "storage-nas": {
      description: "Files and backups · demo",
      transport: "ssh",
      address: "192.0.2.10",
      user: "operator",
      access: "observe",
      ssh_alias: "storage-nas",
      auth: keyReference("storage-nas", inventory),
    },
    "voron-printer": {
      description: "Klipper and Moonraker · demo",
      transport: "ssh",
      address: "192.0.2.20",
      user: "printer",
      access: "user",
      ssh_alias: "voron-printer",
      auth: keyReference("voron-printer", inventory),
    },
    "proxmox-lab": {
      description: "Virtualization · demo",
      transport: "ssh",
      address: "192.0.2.30",
      user: "root",
      access: "full",
      ssh_alias: "proxmox-lab",
      auth: keyReference("proxmox-lab", inventory),
    },
  },
});
const running = await serve({
  inventoryPath: inventory,
  configPath: `${inventory}.ssh_config`,
  port: 0,
  peerPort: 0,
  discover: false,
});
running.hub.state.name = "Linux · demo";
await running.hub.save();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HOMECTL_BROWSER_EXECUTABLE,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const launch = JSON.parse(await readFile(running.launch, "utf8"));
  await page.goto(`${running.url}/#token=${encodeURIComponent(launch.token)}`);
  await expect(
    page.getByRole("heading", { name: "Machines", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("token");
  const out = resolve(import.meta.dir, "../.impeccable/review");
  await (await import("node:fs/promises")).mkdir(out, { recursive: true });
  await page.screenshot({ path: join(out, "desktop.png"), fullPage: true });
  await page.getByRole("searchbox").fill("voron");
  await expect(page.locator("tr[data-search]:visible")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Add machine" }).click();
  await expect(
    page.getByRole("heading", { name: "Add SSH host" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Command", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Review and execute", exact: true })
    .click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(
    page.locator("#confirm-dialog button[value=confirm]"),
  ).toBeEnabled();
  await page.locator("#confirm-dialog button[value=cancel]").click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Devices", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(out, "peers.png"), fullPage: true });
  await page.getByRole("button", { name: "Start pairing" }).click();
  await expect(
    page.getByRole("heading", { name: "Pairing window open" }),
  ).toBeVisible();
  expect(running.hub.pair?.code).toMatch(/^\d{4}-\d{4}$/);
  await page.getByRole("button", { name: "Close pairing" }).click();
  expect(running.hub.pair).toBeUndefined();
  await page.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page.getByLabel("Local KeePassXC password")).toHaveAttribute(
    "type",
    "password",
  );
  await page.screenshot({ path: join(out, "access.png"), fullPage: true });
  const peerId = "11111111-1111-4111-8111-111111111111";
  running.hub.state.peers[peerId] = {
    id: peerId,
    name: "Windows · demo",
    platform: "win32",
    address: "http://127.0.0.1:19999",
    key: "00".repeat(32),
    permissions: {
      sync: true,
      diagnostics: false,
      operations: [],
      administer: false,
    },
    pairedAt: Date.now(),
  };
  const records = structuredClone(await running.hub.snapshot());
  const item = records["machine:storage-nas"];
  if (!item) throw new Error("Missing fixture");
  item.clock = { [peerId]: 1 };
  (item.value as { description: string }).description =
    "Shared family files · demo";
  const proposed = await running.hub.preview(peerId, records);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Use from Linux · demo" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Use from Linux · demo" }).check();
  await expect(
    page.getByRole("heading", { name: "Selected version" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Compare again" }).click();
  await expect(page.locator(".conflict .split")).toBeVisible();
  await page.screenshot({ path: join(out, "conflicts.png"), fullPage: true });
  await page
    .locator("#sync-form")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(running.hub.pending.has(proposed.id)).toBe(false);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Device name").fill("Linux · demo");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved");
  await page.getByRole("link", { name: "Machines", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, "mobile.png"), fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "UI smoke passed: desktop/mobile, filtering, machine form, pairing window, private password field, settings, no browser errors.",
  );
} finally {
  await browser.close();
  await running.stop();
  await rm(root, { recursive: true, force: true });
}
