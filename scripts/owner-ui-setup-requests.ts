// Browser check for agent setup requests (0.3 acceptance). An agent asks, over the
// broker's own HTTP route with its bearer token, for a scan, for a new machine and for
// a permission setting. Adding a machine is refused until the owner has approved a
// scan of its address. The owner approves each one in Needs you, in this order: the
// scan with no password, the new machine with the password and the fingerprint typed
// from the card, and the setting with the password. The broker, the panel and the owner routes
// are real; every ssh and keyscan call goes to a stub, and the addresses are
// documentation addresses, so no machine is contacted and no AI provider is called.
// Screenshots (desktop and phone) go to OWNER_SETUP_SHOTS.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { keyFingerprint } from "../src/broker/host-keys";
import { sessionPaths } from "../src/session";
import { startOwnerPanel } from "../src/web/owner/server";
import type { ProcessResult, ProcessSpec } from "../src/types";

const PASSWORD = "owner setup request password";
const ED =
  "AAAAC3NzaC1lZDI1NTE5AAAAIBVnTGs5JuBXNWbmPAEQX0mCqMnIDoNtKLkV0w8ptQaH";
const FP = keyFingerprint(ED);
const WRONG = `SHA256:${"Q".repeat(43)}`;
const shots = process.env.OWNER_SETUP_SHOTS;

const root = await mkdtemp(join(tmpdir(), "hcsetupreq-"));
const inventoryPath = join(root, "inventory.yaml");
const keysDir = sessionPaths(inventoryPath).keys;
await mkdir(keysDir, { recursive: true });
// The owner made this machine's key in a private terminal (home-ctl key create).
for (const name of ["office-box", "office-box-m"])
  await writeFile(join(keysDir, `${name}.pub`), `ssh-ed25519 ${ED}\n`);
await writeFile(join(keysDir, "nas.pub"), `ssh-ed25519 ${ED}\n`);
await writeFile(
  inventoryPath,
  `version: 1
session:
  ttl: 24h
  database: ${JSON.stringify(join(root, "homelab.kdbx"))}
machines:
  nas:
    description: Synthetic test machine
    transport: ssh
    access: user
    ssh_alias: nas
    address: 192.0.2.10
    user: operator
    auth:
      type: keepassxc
      entry: homectl-nas
      socket: ${JSON.stringify(join(root, "agent.sock"))}
      public_key: ${JSON.stringify(join(keysDir, "nas.pub"))}
`,
);

// Every ssh call is a stub: the keyscan presents one key, and the probe answers as Linux.
const stub = async (spec: ProcessSpec): Promise<ProcessResult> => {
  if (spec.argv.some((arg) => arg.includes("ssh-keyscan")))
    return {
      exitCode: 0,
      stdout: `# stub\n192.0.2.1 ssh-ed25519 ${ED}\n`,
      stderr: "",
    };
  return { exitCode: 0, stdout: "Linux\n", stderr: "" };
};

const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const panelPort = probe.port ?? 0;
probe.stop(true);
const panelOrigin = `http://127.0.0.1:${panelPort}`;
const paths = compatPaths(inventoryPath);
// No executor is passed: the broker's own setup port (the owner routes) is wired.
const daemon = await startDaemon({
  mode: "compat",
  ...paths,
  inventoryPath,
  sshConfigPath: join(root, "ssh_config"),
  panelOrigin,
  machineRunner: stub,
});
await (daemon.verifier as FileVerifier).set(PASSWORD);
await writeFile(
  join(paths.state, "setup.json"),
  JSON.stringify({ version: 1, welcomedAt: Date.now(), steps: {} }),
);
process.env.HOMECTL_BROKER_ENDPOINT = join(paths.state, "endpoint.json");
const panel = await startOwnerPanel({ inventoryPath, port: panelPort });
const browser = await chromium.launch();

const created = await daemon.admin.create({
  id: "codex",
  name: "Codex",
  hosts: ["nas"],
  scopes: ["plan:create", "status:read"],
});
const authorization = `Bearer ${created.token}`;
const agentCall = (path: string, body: Record<string, unknown>) =>
  callBroker<{ id: string; state: string }>(path, body, {
    endpoint: daemon.endpoint,
    authorization,
  });
// The agent's wait: returns once the operation is final (never re-dispatches).
const statusOf = (id: string) =>
  callBroker<{ state: string; result?: { stdout: string; stderr: string } }>(
    "/v1/wait",
    { id, timeoutMs: 20_000 },
    { endpoint: daemon.endpoint, authorization },
  );

async function signIn(page: Page) {
  await page.goto(`${panelOrigin}/`);
  await page.getByLabel("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Needs you", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

// The queue lists each request with its title; Review opens the card.
async function openRequest(page: Page, title: string) {
  const row = page.locator("div.item").filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: "Review" }).click();
  await expect(page.locator("#approval-title")).toContainText(title);
}

async function shot(page: Page, tag: string, label: string) {
  if (shots === undefined) return;
  await mkdir(join(shots, tag), { recursive: true });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  await page.screenshot({
    path: join(shots, tag, `${label}.png`),
    fullPage: true,
  });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// One full pass through the three requests, in one viewport. Each pass uses its own
// machine name, so the passes never share a name or an address.
async function pass(
  tag: string,
  viewport: { width: number; height: number },
  mobile: boolean,
  machine: string,
) {
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: "light",
  });
  const page = await context.newPage();
  // The address this pass adds. It is scanned and approved before the enrolment.
  const addAddress = `192.0.2.${mobile ? 46 : 45}`;
  try {
    // 0. An enrolment before any scan is refused, and the refusal says to scan first.
    await expect(
      agentCall("/v1/setup/request/enroll", {
        name: `${machine}-early`,
        address: addAddress,
        user: "operator",
        access: "user",
      }),
    ).rejects.toThrow("Ask for a scan of that address first");

    // 1. Scan: no password.
    const scan = await agentCall("/v1/setup/request/scan", {
      address: addAddress,
      narrative: "The owner asked me to look at this address.",
    });
    expect(scan.state).toBe("awaiting-approval");
    await signIn(page);
    await openRequest(page, `Look for the SSH key at ${addAddress}`);
    await expect(page.getByLabel("Owner password")).toHaveCount(0);
    await expect(
      page.getByText("Just looks", { exact: true }).first(),
    ).toBeVisible();
    await shot(page, tag, "01-scan-card");
    await noHorizontalScroll(page);
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible({
      timeout: 15_000,
    });
    expect((await statusOf(scan.id)).state).toBe("succeeded");

    // 2. Add a machine: the card asks for the typed fingerprint and the password.
    const add = await agentCall("/v1/setup/request/enroll", {
      name: machine,
      address: addAddress,
      user: "operator",
      access: "user",
      narrative: "The owner wants this box on the list.",
    });
    expect(add.state).toBe("awaiting-approval");
    await page.goto(`${panelOrigin}/`);
    await openRequest(page, `Add ${machine} to homectl`);
    // The badge says what the change does; the risk code stays in Details.
    await expect(
      page.getByText("Gives access", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("Destructive", { exact: true })).toHaveCount(0);
    const approve = page.getByRole("button", { name: "Approve once" });
    await expect(approve).toBeDisabled();
    await shot(page, tag, "02-add-card");
    await noHorizontalScroll(page);
    const typed = page.getByLabel("Type the fingerprint to confirm");
    await typed.fill(WRONG);
    await expect(
      page.getByText("That is not the fingerprint the machine presented."),
    ).toBeVisible();
    await typed.fill(FP);
    await page.getByLabel("Owner password").fill(PASSWORD);
    await expect(approve).toBeEnabled();
    await shot(page, tag, "03-add-typed");
    await approve.click();
    await expect(page.getByText(/Approved/).first()).toBeVisible({
      timeout: 15_000,
    });
    expect((await statusOf(add.id)).state).toBe("succeeded");
    const inventory = await readFile(inventoryPath, "utf8");
    expect(inventory).toContain(`${machine}:`);

    // 3. Permission setting: the password, no fingerprint.
    const preset = await agentCall("/v1/setup/request/preset", {
      preset: "delegated",
    });
    await page.goto(`${panelOrigin}/`);
    await openRequest(
      page,
      "Change the AI permission setting to AI decides more",
    );
    await expect(
      page.getByText("Changes permissions", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByLabel("Owner password")).toBeVisible();
    await expect(
      page.getByLabel("Type the fingerprint to confirm"),
    ).toHaveCount(0);
    await page.getByLabel("Owner password").fill(PASSWORD);
    await shot(page, tag, "04-preset-card");
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible({
      timeout: 15_000,
    });
    const after = await statusOf(preset.id);
    expect(after.state).toBe("succeeded");
    expect(after.result?.stdout).toBe(
      "The AI permission setting is now AI decides more.",
    );
    // The agent reads back plain sentences only: no address, no key.
    const everything =
      JSON.stringify(after) + JSON.stringify(await statusOf(add.id));
    expect(everything).not.toContain(addAddress);
    expect(everything).not.toContain(FP);

    // A keyless Custom provider exercises the owner-only form without network calls.
    const model = `fixture-reviewer-${tag}`;
    const baseUrl = "https://custom-provider.example.test/v1";
    const helper = await agentCall("/v1/setup/request/ai-helper", {
      provider: "custom",
      baseUrl,
      model,
    });
    await page.goto(`${panelOrigin}/`);
    await openRequest(page, "Connect the AI helper");
    await expect(
      page.getByText(`${baseUrl}/chat/completions`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(model, { exact: true })).toBeVisible();
    const reviewerKey = page.getByLabel("AI helper API key (optional)");
    await expect(reviewerKey).toHaveAttribute("type", "password");
    await expect(reviewerKey).toHaveValue("");
    await reviewerKey.fill("fixture-key-must-stay-on-this-card");
    const other = await agentCall("/v1/setup/request/ai-helper", {
      provider: "custom",
      baseUrl,
      model: `${model}-other`,
    });
    await page.evaluate((id) => {
      location.hash = `#/approvals/${id}`;
    }, other.id);
    await expect(
      page.getByText(`${model}-other`, { exact: true }),
    ).toBeVisible();
    await expect(reviewerKey).toHaveValue("");
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    expect((await statusOf(other.id)).state).toBe("denied");
    await expect(
      page.locator("div.item").filter({ hasText: "Connect the AI helper" }),
    ).toHaveCount(1, { timeout: 15_000 });
    await openRequest(page, "Connect the AI helper");
    await expect(reviewerKey).toHaveValue("");
    await page.getByLabel("Owner password").fill(PASSWORD);
    await noHorizontalScroll(page);
    await approve.click();
    expect((await statusOf(helper.id)).state).toBe("succeeded");
  } finally {
    await context.close();
  }
}

try {
  await pass("desktop", { width: 1280, height: 900 }, false, "office-box");
  await pass("phone", { width: 390, height: 844 }, true, "office-box-m");
  console.log("owner-ui-setup-requests: ok");
  if (shots !== undefined) console.log(`screenshots: ${shots}`);
} finally {
  await browser.close();
  await panel.stop?.();
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
