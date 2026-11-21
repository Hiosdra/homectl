// Browser check for the owner panel's Machines section (0.3 guided setup, part 2):
// an empty list, the add sheet from its first step to done, a fingerprint that
// does not match (blocked), a match, enrolment, the machine listed, check again,
// and the focus order. The broker and the panel are real. Every ssh and keyscan
// call goes to a stub, and the addresses are documentation addresses, so no
// machine is contacted. Set OWNER_MACHINE_SHOTS to a folder to keep screenshots.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { keyFingerprint } from "../src/broker/host-keys";
import { sessionPaths } from "../src/session";
import { startOwnerPanel } from "../src/web/owner/server";
import type { ProcessResult, ProcessSpec } from "../src/types";

const PASSWORD = "owner smoke password";
const ED =
  "AAAAC3NzaC1lZDI1NTE5AAAAIBVnTGs5JuBXNWbmPAEQX0mCqMnIDoNtKLkV0w8ptQaH";
const OTHER =
  "AAAAC3NzaC1lZDI1NTE5AAAAIK0nWZHd7cUtOGkcPgmBrVwLDGP0wpZ7VYuBqqOrDsDf";
const FP = keyFingerprint(ED);
const OTHER_FP = keyFingerprint(OTHER);
const shots = process.env.OWNER_MACHINE_SHOTS;

const root = await mkdtemp(join(tmpdir(), "hcmachines-"));
const inventoryPath = join(root, "inventory.yaml");
const keysDir = sessionPaths(inventoryPath).keys;
await mkdir(keysDir, { recursive: true });
await writeFile(
  inventoryPath,
  `version: 1
session:
  ttl: 24h
  database: ${JSON.stringify(join(root, "homelab.kdbx"))}
machines: {}
`,
);

// A stub for every ssh call: the keyscan presents one key, and the probe answers
// as a Linux machine. Nothing leaves this process.
const ED_LINE = `192.0.2.1 ssh-ed25519 ${ED}`;
const stub = async (spec: ProcessSpec): Promise<ProcessResult> => {
  if (spec.argv.some((arg) => arg.includes("ssh-keyscan")))
    return { exitCode: 0, stdout: `# stub\n${ED_LINE}\n`, stderr: "" };
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
const daemon = await startDaemon({
  mode: "compat",
  ...paths,
  inventoryPath,
  sshConfigPath: join(root, "ssh_config"),
  panelOrigin,
  executor: {
    run: async () => ({ exitCode: 0, stdout: "done", stderr: "" }),
  },
  machineRunner: stub,
});
await (daemon.verifier as FileVerifier).set(PASSWORD);
// Welcome of the guided setup counts as seen: these checks start on the machines.
await writeFile(
  join(paths.state, "setup.json"),
  JSON.stringify({ version: 1, welcomedAt: Date.now(), steps: {} }),
);
process.env.HOMECTL_BROKER_ENDPOINT = join(paths.state, "endpoint.json");
const panel = await startOwnerPanel({ inventoryPath, port: panelPort });
const browser = await chromium.launch();

// Each run adds its own machine, so the runs never share a name or an address.
let run = 0;

async function signIn(page: Page) {
  await page.goto(`${panelOrigin}/`);
  await page.getByLabel("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Needs you", exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

async function shot(page: Page, label: string, tag: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  // The sheet fades in; a shot taken mid-fade shows the page through it.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: join(shots, `${tag}-${label}.png`) });
}

async function scenario(
  name: string,
  viewport: { width: number; height: number },
  mobile: boolean,
  scheme: "light" | "dark",
  first: boolean,
) {
  run += 1;
  const machine = `office-nas-${run}`;
  const address = `192.0.2.${100 + run}`;
  const tag = `${name}-${scheme}`;
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.getByRole("button", { name: /^Machines/ }).click();
    await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
    if (first) {
      // Nothing is listed yet, and the empty state offers the first machine.
      await expect(page.getByText("No machines yet.")).toBeVisible();
    }
    await shot(page, "00-empty", tag);

    // Step 1: the form. The default access level is Look only.
    await (
      first
        ? page.getByRole("button", { name: "Add your first machine →" })
        : page.getByRole("button", { name: "Add a machine" })
    ).click();
    const sheet = page.getByRole("dialog", { name: "Add a machine" });
    await expect(sheet).toBeVisible();
    await page.getByLabel(/^Name/).fill(machine);
    await page.getByLabel(/^Address/).fill(address);
    await page.getByLabel(/^Login name/).fill("operator");
    await expect(page.getByLabel(/Look only/)).toBeChecked();
    await shot(page, "01-form", tag);
    await sheet.getByRole("button", { name: "Next: make the key" }).click();

    // Step 2: the key. Nothing moves on until the key appears in the vault.
    await expect(
      page.getByRole("heading", { name: "Make the key" }),
    ).toBeFocused();
    await expect(
      sheet.getByText(`home-ctl key create ${machine}`),
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Next: install the key" }),
    ).toHaveCount(0);
    await shot(page, "02-key-waiting", tag);
    // The owner's private terminal makes the key; the panel finds it by itself.
    await writeFile(join(keysDir, `${machine}.pub`), `ssh-ed25519 ${ED}\n`);
    await expect(
      sheet.getByRole("button", { name: "Next: install the key" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "03-key-ready", tag);
    await sheet.getByRole("button", { name: "Next: install the key" }).click();

    // Step 3: install the key. The platform choice changes the steps.
    await expect(
      page.getByRole("heading", { name: `Install the key on ${machine}` }),
    ).toBeVisible();
    await shot(page, "04-install-linux", tag);
    await sheet
      .getByRole("button", { name: "Next: check the machine's identity" })
      .click();

    // Step 4: identity. The scan is labelled not verified; a wrong fingerprint blocks.
    await expect(
      page.getByRole("heading", { name: "Check that this is your machine" }),
    ).toBeVisible();
    await sheet.getByLabel(/^Owner password/).fill(PASSWORD);
    await sheet.getByRole("button", { name: "Look at the machine" }).click();
    await expect(sheet.getByText("Not verified yet").first()).toBeVisible();
    await expect(sheet.getByText(FP)).toBeVisible();
    const cont = sheet.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();
    await sheet.getByLabel(/^Fingerprint from the machine/).fill(OTHER_FP);
    await expect(sheet.getByText(/does not match yet/)).toBeVisible();
    await expect(cont).toBeDisabled();
    await shot(page, "05-identity-mismatch", tag);
    await sheet.getByLabel(/^Fingerprint from the machine/).fill(FP);
    await expect(sheet.getByText(/It matches the key above/)).toBeVisible();
    await expect(cont).toBeEnabled();
    await shot(page, "06-identity-match", tag);
    await cont.click();

    // Step 5: enrol. The password is asked; the broker pins, writes and probes.
    await expect(
      page.getByRole("heading", { name: "Add the machine" }),
    ).toBeVisible();
    await sheet.getByLabel(/^Owner password/).fill(PASSWORD);
    await shot(page, "07-enroll", tag);
    await sheet.getByRole("button", { name: "Add the machine" }).click();

    // Done: the owner can let an assistant use it.
    await expect(
      sheet.getByText(new RegExp(`${machine} is on your list`)),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      sheet.getByRole("link", { name: "Let an assistant use it" }),
    ).toBeVisible();
    await shot(page, "08-done", tag);
    await sheet.getByRole("button", { name: "Done", exact: true }).click();

    // The list shows it: identity checked, the last check, and no assistant yet.
    const card = page.getByRole("region", { name: machine });
    await expect(card).toBeVisible();
    await expect(card.getByText("Identity checked")).toBeVisible();
    await expect(
      card.getByText(/Last check worked just now \(Linux\)/),
    ).toBeVisible();
    await expect(
      card.getByText("No assistant can reach it yet."),
    ).toBeVisible();
    await card.getByRole("button", { name: "Details" }).click();
    await expect(card.getByText(FP)).toBeVisible();
    await card.getByRole("button", { name: "Hide details" }).click();
    await shot(page, "09-list", tag);

    // Check again: the password, then one read-only check.
    await card.getByRole("button", { name: "Check again" }).click();
    const check = page.getByRole("dialog", { name: `Check ${machine}` });
    await check.getByLabel(/^Owner password/).fill(PASSWORD);
    await check.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText(new RegExp(`${machine} answered`))).toBeVisible(
      {
        timeout: 15_000,
      },
    );

    // The page never scrolls sideways.
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
  await scenario("desktop", { width: 1280, height: 860 }, false, "light", true);
  await scenario("desktop", { width: 1280, height: 860 }, false, "dark", false);
  await scenario("phone", { width: 390, height: 844 }, true, "light", false);
  await scenario("phone", { width: 390, height: 844 }, true, "dark", false);
  console.log(
    "Owner panel machines browser check passed (desktop and phone, light and dark).",
  );
} finally {
  await browser.close();
  panel.stop();
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
