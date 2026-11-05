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
  // Synthetic output for control-plane runs: never the real host's name or account.
  controlRunner: async () => ({
    exitCode: 0,
    stdout: "demo-host\n",
    stderr: "",
  }),
});
running.hub.state.name = "Linux · demo";
await running.hub.save();
// Synthetic control-plane fixtures: two clients, a few operations in each state.
const control = running.control;
const codexToken = (
  await control.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["status:read", "inspect:read", "plan:create"],
    hosts: ["agent-host", "voron-printer"],
  })
).token;
const hermesToken = (
  await control.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["status:read", "inspect:read", "plan:create", "approve:decide"],
    hosts: ["agent-host", "voron-printer"],
  })
).token;
const codex = await control.authenticate(codexToken);
const hermes = await control.authenticate(hermesToken);
if (!codex || !hermes) throw new Error("Fixture clients did not authenticate");
const planAs = (
  client: typeof codex,
  host: string,
  argv: string[],
  impact: string,
) =>
  control.request(
    { kind: "client", client },
    { op: "plan", host, argv, impact },
  ) as Promise<{ operationId: string; fingerprint: string }>;
// Inspection: runnable by the operator without a second client.
await planAs(codex, "agent-host", ["hostname"], "Read the host name");
// Mutation waiting for another client (pending).
await planAs(
  codex,
  "voron-printer",
  ["systemctl", "restart", "nginx"],
  "Restart the web service",
);
// Mutation approved by another client (approved).
const approvedPlan = await planAs(
  codex,
  "voron-printer",
  ["systemctl", "restart", "sshd"],
  "Restart the SSH service",
);
await control.request(
  { kind: "client", client: hermes },
  {
    op: "approve",
    operationId: approvedPlan.operationId,
    fingerprint: approvedPlan.fingerprint,
    decision: "approve",
  },
);
// A finished, harmless run (succeeded) executed by the local operator.
const finished = await planAs(
  codex,
  "agent-host",
  ["whoami"],
  "Read the account name",
);
await control.request(
  { kind: "local-operator" },
  { op: "execute", operationId: finished.operationId },
);
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
  // Approvals: the queue, an inspection run from the panel, and the client list.
  await page.getByRole("link", { name: /^Approvals/ }).click();
  await expect(
    page.getByRole("heading", { name: "Approvals", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/entries · head/)).toBeVisible();
  await page.screenshot({ path: join(out, "approvals.png"), fullPage: true });
  await page.getByRole("button", { name: /^Needs approval/ }).click();
  await expect(
    page.getByText("Waiting for approval by another client"),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "approvals-needs.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Ready to run/ }).click();
  // Target the inspection row only: the approved SSH change in the same tab must not run.
  const inspectionRun = page
    .locator("tr", { hasText: "hostname" })
    .getByRole("button", { name: "Execute", exact: true });
  // Escape cancels the confirmation and returns focus to the Execute button.
  await inspectionRun.click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await expect(inspectionRun).toBeFocused();
  await inspectionRun.click();
  await expect(
    page.locator("#confirm-dialog button[value=confirm]"),
  ).toBeVisible();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(
    page.getByRole("heading", { name: "Execution result", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("✓ succeeded on agent-host")).toBeVisible();
  await expect(page.locator("#control-result")).toBeFocused();
  await expect(page.locator("#control-live")).toContainText(
    "finished: succeeded",
  );
  await page.getByRole("tab", { name: "Clients", exact: true }).click();
  await expect(page.getByText("Codex PC", { exact: true })).toBeVisible();
  await expect(page.getByText("homectl control client add")).toBeVisible();
  await page.getByRole("tab", { name: "Operations", exact: true }).click();
  // Full-page captures start at the top so the sticky rail is not offset.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(out, "approvals-done.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Machines", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: /^Approvals/ }).click();
  await expect(
    page.getByRole("heading", { name: "Approvals", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "approvals-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Machines", exact: true }).click();
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
    "UI smoke passed: desktop/mobile, filtering, machine form, pairing window, private password field, settings, approvals queue and execution, no browser errors.",
  );
} finally {
  await browser.close();
  await running.stop();
  await rm(root, { recursive: true, force: true });
}
