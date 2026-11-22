// Browser check for the owner panel's guided setup (0.3 part 3): a fresh broker opens
// the wizard at Welcome on the first sign-in, then welcome, skip, resume, a deep link,
// the two paths on Welcome and the switch to the AI agent page (and back), a permissions
// choice that the broker records, reload keeping progress, the checklist
// states, the completed and upgrade states, focus order, and phone and desktop in light
// and dark. The broker and the panel are real, and every progress mark goes to the real
// broker. The completed and upgrade states are answered by Playwright stubs of the status
// read, because a real vault cannot be made in this harness; the detection behind those
// states is unit-tested in tests/broker-setup.test.ts. No machine is contacted.
// Set OWNER_SETUP_SHOTS to a folder to keep screenshots.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page, type Route } from "@playwright/test";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { startOwnerPanel } from "../src/web/owner/server";
import type { ProcessResult, ProcessSpec } from "../src/types";

const PASSWORD = "owner setup password";
const shots = process.env.OWNER_SETUP_SHOTS;

const root = await mkdtemp(join(tmpdir(), "hcsetupui-"));
const inventoryPath = join(root, "inventory.yaml");
await writeFile(
  inventoryPath,
  `version: 1
session:
  ttl: 24h
  database: ${JSON.stringify(join(root, "homelab.kdbx"))}
machines: {}
`,
);

// Nothing reaches a machine: every ssh call is answered by this stub.
const stub = async (_spec: ProcessSpec): Promise<ProcessResult> => ({
  exitCode: 1,
  stdout: "",
  stderr: "stubbed",
});

const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const panelPort = probe.port ?? 0;
probe.stop(true);
const panelOrigin = `http://127.0.0.1:${panelPort}`;
const paths = compatPaths(inventoryPath);
const daemon = await startDaemon({
  mode: "compat",
  ...paths,
  inventoryPath,
  sshConfigPath: join(root, "ssh_config"),
  panelOrigin,
  executor: { run: async () => ({ exitCode: 0, stdout: "done", stderr: "" }) },
  machineRunner: stub,
});
await (daemon.verifier as FileVerifier).set(PASSWORD);
process.env.HOMECTL_BROKER_ENDPOINT = join(paths.state, "endpoint.json");
const panel = await startOwnerPanel({ inventoryPath, port: panelPort });
const browser = await chromium.launch();

async function signIn(page: Page) {
  await page.goto(`${panelOrigin}/`);
  await page.getByLabel("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function shot(page: Page, label: string, tag: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  // A hash change can still be settling; the wait only avoids a mid-fade shot.
  await page
    .evaluate(() =>
      Promise.all(
        document.getAnimations().map((animation) => animation.finished),
      ),
    )
    .catch(() => undefined);
  await page.screenshot({
    path: join(shots, `${tag}-${label}.png`),
    fullPage: true,
  });
}

// A status like the broker's, for the states a real vault would reach. Only the
// fields the panel reads are needed; the shape matches setup-api.ts.
function stubStatus(options: {
  completed?: boolean;
  dismissed?: boolean;
  upgrade?: boolean;
}) {
  const required = [
    "vault",
    "machine",
    "assistant",
    "first-request",
    "permissions",
  ];
  const optional = ["devices", "notifications"];
  const done = options.completed === true;
  const steps = [...required, ...optional].map((id) => ({
    id,
    required: required.includes(id),
    detected: done && required.includes(id),
    stored: null,
    state: done && required.includes(id) ? "done" : "open",
  }));
  return {
    welcomed: true,
    completed: done,
    dismissed: options.dismissed === true,
    ...(options.upgrade ? { upgrade: { at: 1, acknowledged: false } } : {}),
    steps,
    next: done ? null : "vault",
    counts: {
      required: 5,
      requiredDone: done ? 5 : 0,
      optional: 2,
      optionalDone: 0,
    },
    facts: {
      vault: done,
      machines: done ? 1 : 0,
      readyMachines: done ? 1 : 0,
      assistants: done ? 1 : 0,
      connectedAssistants: done ? 1 : 0,
      requests: done ? 1 : 0,
      resolvedApprovals: done ? 1 : 0,
      permissionsRevision: done ? 1 : 0,
      workspaceServer: false,
      pairedDevices: 0,
    },
  };
}

async function answerWith(page: Page, body: unknown) {
  await page.route("**/v1/owner/setup", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
  await page.route("**/v1/owner/setup/step", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

// The page never scrolls sideways.
async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// The first run, the real broker: Welcome opens by itself, then the steps.
async function firstRun(page: Page, tag: string) {
  await signIn(page);
  // Opened by itself at Welcome, not on Needs you.
  await expect(page).toHaveURL(/#\/setup\/welcome$/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Welcome", exact: true }),
  ).toBeFocused();
  await shot(page, "01-welcome", tag);

  // Welcome offers the two paths; this run takes the step-by-step one.
  await expect(
    page.getByRole("button", { name: /Let your AI agent set it up for you/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Set it up step by step/ }).click();
  await expect(page).toHaveURL(/#\/setup\/vault$/);
  await expect(
    page.getByRole("heading", { name: "Vault and sign-in", exact: true }),
  ).toBeFocused();
  await expect(page.getByText("0 of 5 needed · 0 of 2 optional")).toBeVisible();
  await expect(page.getByText("home-ctl setup", { exact: true })).toBeVisible();
  await shot(page, "02-vault", tag);

  // Skip: the step says so, and the wizard moves on to the machine step.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/#\/setup\/machine$/);
  await expect(
    page.getByRole("link", { name: /Vault and sign-in/ }).getByText("Skipped"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Add your first machine", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Add a machine" }),
  ).toBeVisible();
  await shot(page, "03-machine", tag);

  // Back, then a reload: the progress is the broker's, so it survives the reload.
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/setup\/vault$/);
  await page.reload();
  await expect(
    page.getByRole("link", { name: /Vault and sign-in/ }).getByText("Skipped"),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Come back to this" }).click();
  await expect(
    page.getByRole("button", { name: "Skip for now" }),
  ).toBeVisible();

  // The permissions choice (a deep link): "Keep Ask me first" is equally visible,
  // and the broker records it.
  await page.goto(`${panelOrigin}/#/setup/permissions`);
  await expect(
    page.getByRole("heading", {
      name: "Choose how much homectl decides",
      exact: true,
    }),
  ).toBeFocused();
  const keep = page.getByRole("button", { name: "Keep “Ask me first”" });
  const other = page.getByRole("link", { name: "Open Permissions" });
  await expect(keep).toBeVisible();
  await expect(other).toBeVisible();
  await shot(page, "04-permissions", tag);
  await keep.click();
  await expect(page.getByText("You kept “Ask me first”.")).toBeVisible();
  await expect(page.getByText("1 of 5 needed · 0 of 2 optional")).toBeVisible();

  // The checklist on Needs you: the states, one link per step, and the count.
  await page.goto(`${panelOrigin}/#/`);
  const card = page.getByRole("region", { name: "Finish setup" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("1 of 5 needed · 0 of 2 optional")).toBeVisible();
  // Vault was reopened after the skip, so it is the next step.
  await expect(card.getByText("Next", { exact: true })).toHaveCount(1);
  await expect(card.getByText("Skipped", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Done", { exact: true })).toBeVisible();
  await expect(card.getByText("Optional", { exact: true })).toHaveCount(2);
  // The other open required steps are to do.
  await expect(card.getByText("To do", { exact: true })).toHaveCount(3);
  await shot(page, "05-checklist", tag);
  // The checklist does not add to the attention badge in the title.
  await expect(page).toHaveTitle("homectl owner");

  // A new step opens from the checklist's own link.
  await card.getByRole("link", { name: "Open: Connect an assistant" }).click();
  await expect(page).toHaveURL(/#\/setup\/assistant$/);
  await expect(
    page.getByRole("heading", { name: "Connect an assistant", exact: true }),
  ).toBeFocused();
  await shot(page, "06-assistant", tag);

  // The owner switches to the AI agent path from the wizard, and back again. The
  // choice is the broker's, so the switch is answered by the real status read.
  await page
    .getByRole("button", { name: "Let your AI agent set it up instead" })
    .click();
  await expect(page).toHaveURL(/#\/setup\/agent$/);
  await expect(
    page.getByRole("heading", {
      name: "Let your AI agent set it up",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("home-ctl agent connect")).toBeVisible();
  await shot(page, "10-agent-page", tag);
  await page
    .getByRole("button", { name: "Set it up step by step instead" })
    .click();
  await expect(page).not.toHaveURL(/#\/setup\/agent$/);
}

// The agent page, from any state: its four stages and the copy buttons are there.
async function agentPage(page: Page, tag: string) {
  await page.goto(`${panelOrigin}/#/setup/agent`);
  await expect(
    page.getByRole("heading", {
      name: "Let your AI agent set it up",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Copy setup prompt" }),
  ).toBeVisible();
  await shot(page, "10-agent-page", tag);
  await noSideScroll(page);
}

async function scenario(
  name: string,
  viewport: { width: number; height: number },
  mobile: boolean,
  scheme: "light" | "dark",
  first: boolean,
) {
  const tag = `${name}-${scheme}`;
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  try {
    if (first) await firstRun(page, tag);
    else {
      await signIn(page);
      await expect(
        page.getByRole("heading", { name: "Needs you", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await page.goto(`${panelOrigin}/#/setup/notifications`);
      await expect(
        page.getByRole("heading", {
          name: "Notifications and updates",
          exact: true,
        }),
      ).toBeFocused();
      await shot(page, "07-notifications", tag);
      await agentPage(page, tag);
    }
    await noSideScroll(page);
  } finally {
    await context.close();
  }
}

try {
  await scenario("desktop", { width: 1280, height: 860 }, false, "light", true);
  await scenario("desktop", { width: 1280, height: 860 }, false, "dark", false);
  await scenario("phone", { width: 390, height: 844 }, true, "light", false);
  await scenario("phone", { width: 390, height: 844 }, true, "dark", false);

  // The completed state, from a stub: the card collapses to one line, and hiding it
  // leaves nothing on Needs you.
  const stubbed = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });
  const page = await stubbed.newPage();
  try {
    await signIn(page);
    await answerWith(page, stubStatus({ completed: true }));
    await page.goto(`${panelOrigin}/#/`);
    await expect(page.getByText("You're set up.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("region", { name: "Finish setup" }),
    ).toHaveCount(0);
    await shot(page, "08-complete-collapsed", "stub-desktop-light");
    await answerWith(page, stubStatus({ completed: true, dismissed: true }));
    await page.reload();
    await expect(page.getByText("You're set up.")).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await stubbed.close();
  }

  // The upgrade notice, from a stub, and its acknowledgement.
  const upgraded = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await upgraded.newPage();
  try {
    await signIn(phone);
    await answerWith(phone, stubStatus({ upgrade: true }));
    await phone.goto(`${panelOrigin}/#/`);
    await expect(
      phone.getByRole("heading", { name: "homectl updated your saved data" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await shot(phone, "09-upgrade", "stub-phone-light");
    await noSideScroll(phone);
  } finally {
    await upgraded.close();
  }

  console.log(
    "Owner panel setup browser check passed (desktop and phone, light and dark; completed and upgrade states stubbed).",
  );
} finally {
  await browser.close();
  panel.stop();
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
