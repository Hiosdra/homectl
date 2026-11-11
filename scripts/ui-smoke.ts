// Disposable synthetic workspace. Never reads the owner's homectl database.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import {
  applyClient,
  applyOp,
  type ClientBody,
  type OpBody,
  sealRecord,
} from "../src/control/replicate";
import { loadInventory, saveInventory } from "../src/inventory";
import { serve } from "../src/serve";
import { keyReference } from "../src/session/keys";
import { assertExecuteInsideCard, denyReadyRequest } from "./ui-smoke-steps";

const root = await mkdtemp(join(tmpdir(), "hcui-"));
const inventory = join(root, "inventory.yaml");
const panelInterface = Object.values(networkInterfaces())
  .flat()
  .find(
    (address) =>
      address?.family === "IPv4" &&
      !address.internal &&
      !address.address.startsWith("127.") &&
      !address.address.startsWith("169.254."),
  )?.address;
if (!panelInterface)
  throw new Error("UI smoke needs one non-loopback IPv4 interface");
const portProbe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const panelPort = portProbe.port;
portProbe.stop(true);
const panelOrigin = `http://${panelInterface}:${panelPort}`;
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
    "discard-me": {
      description: "Disposable fixture",
      transport: "ssh",
      address: "192.0.2.40",
      user: "operator",
      access: "observe",
      ssh_alias: "discard-me",
      auth: keyReference("discard-me", inventory),
    },
  },
});
const disposablePublicKey = keyReference("discard-me", inventory).public_key;
await mkdir(join(root, "public-keys"), { recursive: true });
await writeFile(disposablePublicKey, "synthetic-key-to-retain");
const running = await serve({
  inventoryPath: inventory,
  configPath: `${inventory}.ssh_config`,
  port: panelPort,
  peerPort: 0,
  interface: panelInterface,
  discover: false,
  panel: {
    interface: panelInterface,
    origin: panelOrigin,
    accessToken: randomBytes(32).toString("base64url"),
  },
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
  await page.goto(`${panelOrigin}/#token=${encodeURIComponent(launch.token)}`);
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("token");
  const out = process.env.UI_REVIEW_DIR ?? join(root, "review");
  await (await import("node:fs/promises")).mkdir(out, { recursive: true });
  await page.screenshot({ path: join(out, "desktop.png"), fullPage: true });
  await page.getByRole("link", { name: /^Vault/ }).click();
  await expect(
    page.getByRole("heading", { name: "Machines", exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("voron");
  await expect(page.locator("tr[data-search]:visible")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");
  await page
    .getByRole("row")
    .filter({ hasText: "discard-me" })
    .getByRole("button", { name: "Edit" })
    .click();
  await page.getByRole("button", { name: "Remove machine" }).click();
  await expect(page.locator("#confirm-dialog")).toContainText(
    "vault credential",
  );
  await page.locator("#confirm-dialog button[value=cancel]").click();
  expect((await loadInventory(inventory)).machines["discard-me"]).toBeDefined();
  await page.getByRole("button", { name: "Remove machine" }).click();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(page.locator("#notice")).toContainText(
    "Machine discard-me removed",
  );
  await expect(
    page.getByRole("row").filter({ hasText: "discard-me" }),
  ).toHaveCount(0);
  const afterRemoval = await loadInventory(inventory);
  expect(afterRemoval.machines["discard-me"]).toBeUndefined();
  expect(afterRemoval.machines["storage-nas"]).toBeDefined();
  expect(await readFile(disposablePublicKey, "utf8")).toBe(
    "synthetic-key-to-retain",
  );
  const localRemovalStatus = await page.evaluate(async () => {
    const result = await fetch("/api/machine/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent-host" }),
    });
    return result.status;
  });
  expect(localRemovalStatus).toBe(403);
  expect((await loadInventory(inventory)).machines["agent-host"]).toBeDefined();
  expect(await readFile(`${inventory}.ssh_config`, "utf8")).not.toContain(
    "Host discard-me",
  );
  await page.getByRole("button", { name: "Add machine" }).click();
  await expect(
    page.getByRole("heading", { name: "Add SSH host" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Command", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Program")).toHaveValue("uname");
  await expect(page.getByLabel("Arguments (one per line)")).toHaveValue("-s");
  await page
    .getByRole("button", { name: "Review command", exact: true })
    .click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(
    page.locator("#confirm-dialog button[value=confirm]"),
  ).toBeEnabled();
  await page.locator("#confirm-dialog button[value=cancel]").click();
  await expect(page.locator("#confirm-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: /^Sync/ }).click();
  await expect(
    page.getByRole("heading", { name: "Sync", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(out, "peers.png"), fullPage: true });
  await page.getByRole("button", { name: "Start pairing" }).click();
  await expect(
    page.getByRole("heading", { name: "Pairing window open" }),
  ).toBeVisible();
  expect(running.hub.pair?.code).toMatch(/^\d{4}-\d{4}$/);
  await expect(page.getByText(/^homectl pair --address /)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy one-time code" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel pairing" }).click();
  expect(running.hub.pair).toBeUndefined();
  // Model a new device with no SSH keys yet. Once the vault is created, the
  // synthetic SSH hosts are restored for the remaining machine/control flows.
  await saveInventory(inventory, {
    version: 1,
    session: { ttl: "24h", database: join(root, "homelab.kdbx") },
    machines: {
      "agent-host": {
        description: "Local device · demonstration data",
        transport: "local",
        access: "user",
      },
    },
  });
  await page.getByRole("link", { name: /^Vault/ }).click();
  const smokePassword = "local UI smoke password";
  await page.getByLabel("Choose a vault password").fill(smokePassword);
  await page.getByLabel("Confirm vault password").fill(smokePassword);
  await page.getByRole("button", { name: "Create and unlock vault" }).click();
  await expect(
    page.getByRole("heading", { name: "Vault unlocked" }),
  ).toBeVisible();
  await expect(
    page.getByText("Vault created and unlocked on this device."),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.screenshot({ path: join(out, "access.png"), fullPage: true });
  const peerId = "11111111-1111-4111-8111-111111111111";
  running.hub.state.peers[peerId] = {
    id: peerId,
    name: "Legacy · demo",
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
  await expect(page.locator("[data-conflict] article").first()).toContainText(
    "Machine: storage-nas",
  );
  await expect(page.locator("[data-conflict] pre")).toHaveCount(0);
  // The later change is preselected, so the first explicit choice is the other version.
  await expect(
    page.getByRole("radio", { name: "Use from Linux · demo" }),
  ).toBeChecked();
  await page.getByRole("radio", { name: "Use from Legacy · demo" }).check();
  await expect(
    page.getByRole("heading", { name: "Selected version" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Compare again" }).click();
  await expect(
    page.locator("[data-conflict]").getByText("Received", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(out, "conflicts.png"), fullPage: true });
  await page.getByText("Changes to review", { exact: true }).click();
  await expect(page.locator("#sync-form article").first()).toBeVisible();
  await expect(page.locator("#sync-form pre")).toHaveCount(0);
  let compareCount = 0;
  let remoteBlocksPreview = false;
  await page.route("**/api/sync/start", (route) => {
    compareCount++;
    return route.fulfill({
      status: 200,
      json: {
        ...proposed,
        id: `preview-${compareCount}`,
        ...(remoteBlocksPreview
          ? { blocker: { type: "remote_vault_locked" } }
          : {}),
      },
    });
  });
  await page.route("**/api/sync/apply", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: "Unlock the local vault before accepting credential changes",
      },
    }),
  );
  await page.locator("#sync-form button[type=submit]").click();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(page.locator("#sync-unlock-dialog")).toBeVisible();
  await page.route("**/api/vault/unlock", (route) =>
    route.fulfill({ status: 200, json: { unlocked: true } }),
  );
  await page.getByLabel("Vault password", { exact: true }).fill(smokePassword);
  await page.locator("#sync-unlock-form button[type=submit]").click();
  await expect(page.locator("#notice")).toContainText(
    "Vault unlocked. Review the updated changes",
  );
  expect(compareCount).toBe(1);
  await page.unroute("**/api/sync/apply");
  await page.unroute("**/api/vault/unlock");
  let remoteUnlocked = false;
  let readinessChecks = 0;
  let applyAttempts = 0;
  await page.route("**/api/sync/readiness", (route) => {
    readinessChecks++;
    return route.fulfill({
      status: 200,
      json: { vaultUnlocked: remoteUnlocked },
    });
  });
  await page.route("**/api/sync/apply", (route) => {
    applyAttempts++;
    return route.fulfill({
      status: 503,
      json: {
        error:
          "The other device's vault was locked when the devices were compared. Unlock it there and compare again.",
      },
    });
  });
  await page.getByRole("radio", { name: "Use from Linux · demo" }).check();
  await page.locator("#sync-form button[type=submit]").click();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(page.locator("#sync-wait-title")).toContainText("Legacy · demo");
  await expect(page.locator("#sync-wait-status")).toContainText(
    "updates automatically",
  );
  await expect(
    page.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
  await expect(page.locator("#sync-form button[type=submit]")).toBeDisabled();
  await expect.poll(() => readinessChecks).toBeGreaterThan(0);
  remoteUnlocked = true;
  await expect(page.locator("#notice")).toContainText(
    "other vault is unlocked",
    { timeout: 10_000 },
  );
  expect(compareCount).toBe(2);
  expect(applyAttempts).toBe(1);
  // The refreshed comparison starts from its own default, not the earlier choice.
  await expect(
    page.getByRole("radio", { name: "Use from Linux · demo" }),
  ).toBeChecked();
  remoteUnlocked = false;
  remoteBlocksPreview = true;
  await page.getByRole("button", { name: "Compare devices again" }).click();
  await expect(page.locator("#sync-wait-title")).toBeVisible();
  await expect(page.locator("#sync-form button[type=submit]")).toBeDisabled();
  expect(applyAttempts).toBe(1);
  remoteBlocksPreview = false;
  remoteUnlocked = true;
  await expect(page.locator("#notice")).toContainText(
    "other vault is unlocked",
    { timeout: 12_000 },
  );
  expect(applyAttempts).toBe(1);
  await page.unroute("**/api/sync/readiness");
  await page.unroute("**/api/sync/apply");
  await page.unroute("**/api/sync/start");
  await page
    .locator("#sync-form")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  expect(running.hub.pending.has(proposed.id)).toBe(false);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Device name").fill("Linux · demo");
  await page.getByLabel("Session lifetime").click();
  await page.getByRole("option", { name: "Custom duration…" }).click();
  await expect(page.getByLabel("Duration")).toBeVisible();
  await page.getByLabel("Duration").fill("2d");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved");
  // Replicated state (synthetic), written through the real signing path. Each
  // fixture device has its own Ed25519 key; every record is sealed by its
  // device and applied through the same verification that sync uses.
  const rep = running.replicator;
  if (!rep) throw new Error("Control replicator is not running");
  const now = new Date().toISOString();
  const windows = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Windows · demo",
    key: await loadOrCreateDeviceKey(join(root, "keys-windows")),
  };
  const mac = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Mac · demo",
    key: await loadOrCreateDeviceKey(join(root, "keys-mac")),
  };
  for (const device of [windows, mac]) {
    await rep.addPeer(device.id, device.name, device.key.publicKey);
    running.hub.state.peers[device.id] = {
      id: device.id,
      name: device.name,
      platform: "win32",
      address: "http://127.0.0.1:19998",
      key: "00".repeat(32),
      signingKey: device.key.publicKey,
      permissions: {
        sync: true,
        diagnostics: false,
        operations: [],
        administer: false,
      },
      pairedAt: Date.now(),
    };
  }
  // The legacy peer (paired before signing keys) cannot sign: it is excluded from the lease.
  await rep.addPeer(peerId, "Legacy · demo");
  // Any verified exchange sets the last contact; an empty pull is enough here.
  await rep.receive({ origins: {} }, windows.id);
  await rep.receive({ origins: {} }, mac.id);
  const publish = (device: typeof windows, body: OpBody) => {
    const outcome = applyOp(rep.replica, sealRecord(device, body), {
      [device.id]: device.key.publicKey,
    });
    if (outcome !== "applied")
      throw new Error(`Fixture record rejected: ${outcome}`);
  };
  const remoteOp = (opId: string, state: string, approver?: string) =>
    ({
      kind: "op",
      opId,
      owner: windows.id,
      planner: windows.id,
      epoch: 1,
      seq: 1,
      state,
      host: "voron-printer",
      argv: ["systemctl", "restart", "nginx"],
      impact: "Restart the web service on the printer",
      classification: "mutation",
      needsApproval: true,
      fingerprint: "7c1e0d2a9b44f1c8",
      issuer: "codex-pc",
      updatedAt: now,
      ...(approver ? { approver } : {}),
    }) as OpBody;
  const approvedRemote = "aaaaaaaa-0000-4000-8000-00000000a001";
  const pendingRemote = "bbbbbbbb-0000-4000-8000-00000000b001";
  const conflicted = "cccccccc-0000-4000-8000-00000000c001";
  const hermesClient = {
    kind: "client",
    clientId: "hermes-windows",
    device: windows.id,
    name: "Hermes Admin",
    scopes: ["status:read", "inspect:read", "plan:create", "approve:decide"],
    hosts: ["agent-host", "voron-printer"],
    createdAt: now,
    revoked: false,
  } as ClientBody;
  const clientOutcome = applyClient(
    rep.replica,
    sealRecord(windows, hermesClient),
    { [windows.id]: windows.key.publicKey },
  );
  if (clientOutcome !== "applied")
    throw new Error(`Fixture client rejected: ${clientOutcome}`);
  publish(windows, remoteOp(approvedRemote, "approved", "hermes-windows"));
  publish(windows, remoteOp(pendingRemote, "pending"));
  publish(windows, remoteOp(conflicted, "pending"));
  // This device forwards an approval; it shows as awaiting confirmation.
  await rep.decide(hermes, pendingRemote, "7c1e0d2a9b44f1c8", "approve");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: /^Sync/ }).click();
  await expect(
    page.getByRole("heading", { name: "Control sync", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("excluded from lease: re-pair required"),
  ).toBeVisible();
  // The Mac device is offline in this fixture: suspend it from the lease, as the
  // operator would from the panel, then check the row.
  await page
    .locator("tr", { hasText: "Mac · demo" })
    .getByRole("button", { name: "Suspend from lease", exact: true })
    .click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(
    page.getByText("suspended by Linux · demo", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.locator("#control-live")).toContainText(
    "Mac · demo is suspended from this device's lease.",
  );
  await page.screenshot({
    path: join(out, "control-sync.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /^Sync/ }).click();
  await expect(
    page.getByText("Re-pair this device to enable control sync").first(),
  ).toBeVisible();
  await expect(page.getByText("Signing key").first()).toBeVisible();
  await page.screenshot({ path: join(out, "devices.png"), fullPage: true });
  // Approvals: the queue, an inspection run from the panel, and the client list.
  await page.getByRole("link", { name: /^(Accept requests|Requests)/ }).click();
  await expect(page.getByText("Runs on Windows · demo").first()).toBeVisible();
  await expect(
    page
      .locator("tr", { hasText: "Runs on Windows · demo" })
      .getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  // Approvals: the queue, an inspection run from the panel, and the client list.
  await page.getByRole("link", { name: /^(Accept requests|Requests)/ }).click();
  await expect(page.getByText("Runs on Windows · demo").first()).toBeVisible();
  await expect(
    page
      .locator("tr", { hasText: "Runs on Windows · demo" })
      .getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Accept requests", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/entries · head/)).toBeVisible();
  await page.screenshot({ path: join(out, "approvals.png"), fullPage: true });
  await page.getByRole("button", { name: /^Needs approval/ }).click();
  await expect(
    page.getByText("Waiting for approval by another client"),
  ).toBeVisible();
  // The forwarded approval shows as awaiting confirmation until the owner reflects it.
  await expect(
    page.getByText("forwarded, awaiting confirmation").first(),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "approvals-needs.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Ready to run/ }).click();
  await assertExecuteInsideCard(page, "1440px");
  await page.setViewportSize({ width: 1280, height: 960 });
  await assertExecuteInsideCard(page, "1280px");
  await page.screenshot({
    path: join(out, "approvals-1280.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  // Target the inspection row only: the approved SSH change in the same tab must not run.
  const inspectionRun = page
    .locator("tr", { hasText: "hostname" })
    .getByRole("button", { name: "Accept", exact: true });
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
  await denyReadyRequest(page, () =>
    planAs(codex, "agent-host", ["uptime"], "Read the uptime"),
  );
  // OIDC: configure the issuer (no network access until a sign-in) and map a
  // client to a synthetic subject. The panel shows the issuer host only.
  await control.configureOidc({
    issuer: "https://idp.example.test",
    audience: "homectl-mcp",
  });
  await control.createClient({
    id: "oidc-codex",
    name: "OIDC Codex",
    scopes: ["status:read", "inspect:read"],
    hosts: ["agent-host"],
    oidc: { claim: "sub", value: "synthetic-subject-01" },
    issueToken: false,
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("tab", { name: "Clients", exact: true }).click();
  await expect(page.getByText("OIDC only · idp.example.test")).toBeVisible();
  await expect(
    page.getByText("Read-only. Change it from a private terminal."),
  ).toBeVisible();
  await expect(page.getByText("synthetic-subject-01")).toHaveCount(0);
  await page.screenshot({
    path: join(out, "clients-oidc.png"),
    fullPage: true,
  });
  await expect(page.getByText("Codex PC", { exact: true })).toBeVisible();
  await expect(page.getByText("homectl control client add")).toBeVisible();
  await page.getByRole("tab", { name: "Operations", exact: true }).click();
  // Full-page captures start at the top so the sticky rail is not offset.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(out, "approvals-done.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /^Vault/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: /^(Accept requests|Requests)/ }).click();
  await expect(
    page.getByRole("heading", { name: "Accept requests", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "approvals-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /^Sync/ }).click();
  await expect(
    page.getByRole("heading", { name: "Control sync", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "sync-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: /^Vault/ }).click();
  await page.screenshot({ path: join(out, "mobile.png"), fullPage: true });
  await page.screenshot({ path: join(out, "mobile-viewport.png") });
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
