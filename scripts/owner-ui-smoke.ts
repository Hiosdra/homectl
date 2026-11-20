// Browser smoke for the owner panel (homelab #21 deliverable 8). A disposable
// workspace, a real broker daemon with a fake executor, the real owner panel
// server, and Chromium at desktop and phone widths. Nothing touches the owner's
// homectl state or any real host.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { startOwnerPanel } from "../src/web/owner/server";
import { type Agent, VIEWPORTS } from "./owner-ui-harness";
import { runOwnerFlowScenarios } from "./owner-ui-flows";
import { runDesignScenarios } from "./owner-ui-design";
import { runFocusScenario } from "./owner-ui-focus";
import { approvalItem, openSecret } from "./owner-ui-waiting";
import { runOwnerExtensionScenarios } from "./owner-ui-workspace";

const PASSWORD = "owner smoke password";
const root = await mkdtemp(join(tmpdir(), "hcowner-"));
const inventoryPath = join(root, "inventory.yaml");
await writeFile(
  inventoryPath,
  "version: 1\nmachines:\n  pc:\n    description: Disposable smoke host\n    transport: local\n    access: user\n",
);

const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const panelPort = probe.port ?? 0;
probe.stop(true);
const panelOrigin = `http://127.0.0.1:${panelPort}`;
const ran: string[][] = [];
const paths = compatPaths(inventoryPath);
const daemon = await startDaemon({
  mode: "compat",
  ...paths,
  inventoryPath,
  sshConfigPath: join(root, "ssh_config"),
  panelOrigin,
  executor: {
    run: async ({ argv }) => {
      ran.push(argv);
      return { exitCode: 0, stdout: "done", stderr: "" };
    },
  },
});
// No vault in this fixture, so the owner password lives in owner.json.
await (daemon.verifier as FileVerifier).set(PASSWORD);
// The panel finds the broker through this file, not a machine-wide one.
process.env.HOMECTL_BROKER_ENDPOINT = join(paths.state, "endpoint.json");
const panel = await startOwnerPanel({ inventoryPath, port: panelPort });

const endpoint = daemon.endpoint;
const { token: ownerToken } = await callBroker<{ token: string }>(
  "/v1/owner/login",
  { password: PASSWORD },
  { endpoint },
);
const owner = { endpoint, authorization: `Owner ${ownerToken}` };
const agent = await callBroker<{ token: string }>(
  "/v1/owner/clients/create",
  { id: "codex-smoke", name: "Codex smoke", hosts: ["pc"], password: PASSWORD },
  owner,
);
const asAgent = { endpoint, authorization: `Bearer ${agent.token}` };

// A command the default policy does not know is "opaque": R3, so it needs the
// owner password (step-up) before it can run.
async function requestApproval(label: string) {
  return callBroker<{ id: string; state: string }>(
    "/v1/exec",
    {
      host: "pc",
      argv: ["smoke-tool", "--apply", label],
      narrative: `Apply ${label}. I checked the dry run first.`,
    },
    asAgent,
  );
}

// Any argv, as the smoke agent on host "pc". The default policy decides it.
async function requestCommand(argv: string[]) {
  return callBroker<{ id: string; state: string }>(
    "/v1/exec",
    { host: "pc", argv },
    asAgent,
  );
}

// A new agent on host "pc". Its risk budget starts empty, so the other scenarios'
// requests cannot use it up and change the verdicts this agent gets.
async function createAgent(id: string): Promise<Agent> {
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id, name: `Smoke ${id}`, hosts: ["pc"], password: PASSWORD },
    owner,
  );
  return { id, authorization: `Bearer ${created.token}` };
}

async function requestCommandAs(agentToRun: Agent, argv: string[]) {
  return callBroker<{ id: string; state: string }>(
    "/v1/exec",
    { host: "pc", argv },
    { endpoint, authorization: agentToRun.authorization },
  );
}

// The broker's own count of what waits for the owner: approvals plus secret requests.
async function waitingOnBroker() {
  const [approvals, secrets] = await Promise.all([
    callBroker<unknown[]>("/v1/owner/pending", {}, owner),
    callBroker<unknown[]>("/v1/owner/secrets/pending", {}, owner),
  ]);
  return approvals.length + secrets.length;
}

// A label makes the request distinct: the broker returns the existing pending
// request for an identical one.
async function requestSecret(label = "") {
  const suffix = label ? `-${label}` : "";
  return callBroker<{ id: string }>(
    "/v1/secret/request",
    {
      purpose: `Store the smoke API token for the smoke tool${suffix}`,
      destination: {
        kind: "ssh-stdin",
        host: "pc",
        argv: ["tee", `/tmp/smoke-token${suffix}`],
      },
      fields: [{ name: "token", label: "API token", kind: "token" }],
    },
    asAgent,
  );
}

const browser = await chromium.launch();

async function signIn(page: Page) {
  await page.goto(`${panelOrigin}/`);
  await page.getByLabel("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: /Nothing needs you|Needs you/ }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

async function runScenario(
  name: string,
  viewport: { width: number; height: number },
  mobile: boolean,
) {
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  try {
    await signIn(page);
    // The session cookie is HttpOnly: nothing readable from script, and no
    // token ever appears in the address bar.
    // The broker scopes the session cookie to /v1/owner, so ask under that path.
    const cookies = await context.cookies(`${panelOrigin}/v1/owner/pending`);
    const session = cookies.find((cookie) => cookie.name === "hc_owner");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Strict");
    expect(page.url()).not.toMatch(/hco_|hct_|password/);

    // Live: work created while the overview is open appears without a reload. The
    // broker is shared with other scenarios, so this scenario finds its own request
    // by its label and never the first one on the page.
    const argv = ["smoke-tool", "--apply", name];
    const approval = await requestApproval(name);
    expect(approval.state).toBe("awaiting-approval");
    const secret = await requestSecret(name);
    await expect(
      approvalItem(page, argv).getByRole("button", { name: "Review" }),
    ).toBeVisible({ timeout: 10_000 });

    // Approval with step-up: the button stays disabled until the password is typed.
    await approvalItem(page, argv)
      .getByRole("button", { name: "Review" })
      .click();
    await expect(page.locator("#approval-title")).toBeVisible();
    await expect(page.getByText("smoke-tool", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Written by the assistant · not verified/),
    ).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve once" });
    await expect(approve).toBeDisabled();
    await page.getByLabel("Owner password").fill(PASSWORD);
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(page.getByText(/Approved/).first()).toBeVisible({
      timeout: 15_000,
    });
    // Dispatch runs after the decision returns; poll until the executor ran.
    await expect
      .poll(() => ran.at(-1), { timeout: 15_000 })
      .toEqual(["smoke-tool", "--apply", name]);

    // Secret: the token field is masked, the value is cleared after submit.
    await openSecret(page, secret.id, name);
    const token = page.getByLabel(/API token/);
    await expect(token).toHaveAttribute("type", "password");
    await token.fill("smoke-token-value");
    // Providing a value is a step-up: the owner password is required.
    await page.getByLabel(/Owner password/).fill(PASSWORD);
    await page.getByRole("button", { name: "Provide secret" }).click();
    await expect(page.getByText(/Provided for one hour in memory/)).toBeVisible(
      { timeout: 15_000 },
    );

    // Agents: create one; the token is shown once.
    await page.getByRole("button", { name: /^Assistants/ }).click();
    await page.getByLabel("Name", { exact: true }).fill(`Smoke ${name}`);
    await page.getByLabel("pc", { exact: true }).check();
    await page.getByLabel("Owner password").fill(PASSWORD);
    await page.getByRole("button", { name: "Add assistant" }).click();
    await expect(page.getByText("Shown once. Copy it now")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel("Assistant key")).toContainText("hct_");

    // Layout: no horizontal scrolling at this width.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
}

try {
  await runScenario("desktop", { width: 1280, height: 860 }, false);
  await runScenario("phone", { width: 390, height: 844 }, true);
  // Workspace, decisions (step-up included), updates and notifications.
  const harness = {
    browser,
    panelOrigin,
    password: PASSWORD,
    requestApproval,
    requestSecret,
    requestCommand,
    createAgent,
    requestCommandAs,
    ranCommands: () => ran,
    waitingOnBroker,
  };
  await runOwnerExtensionScenarios(harness);
  // Remembered rules, the attention inbox, the stream dropping and returning.
  await runOwnerFlowScenarios(harness);
  // Design: information architecture, accessible names and headings, one-tap
  // approval from the list, and the remembered section.
  await runDesignScenarios(harness);
  // Keyboard order and focus rings on every main screen, at both widths.
  for (const viewport of VIEWPORTS) await runFocusScenario(harness, viewport);
  console.log("Owner panel browser smoke passed (desktop and phone).");
} finally {
  await browser.close();
  panel.stop();
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
