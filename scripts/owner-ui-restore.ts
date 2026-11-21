// Browser checks for backup requests and restores of a linked client (homelab #21
// §6). A request changes one flag. A restore is three steps: the backup and a reason,
// what will happen (the client is cut off, a fresh identity), then a check of the
// backup with the owner password and a second password entry to confirm. Only after
// that does the one-time code appear, and it stays until the owner confirms it.

import { expect, type Locator, type Page } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  open,
  RESTORE_CODE,
  serveWorkspace,
  signIn,
  type VIEWPORTS,
  type WorkspaceStub,
  workspaceStub,
} from "./owner-ui-harness";

type Viewport = (typeof VIEWPORTS)[number];

async function openWorkspace(page: Page, harness: Harness) {
  await signIn(page, harness);
  await expect(
    page.getByRole("button", { name: "Devices & backup 5" }),
  ).toBeVisible({ timeout: 10_000 });
  await page
    .getByRole("button", { name: "Review in Devices & backup" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Devices & backup" }),
  ).toBeVisible();
}

// Step 1 to step 3: the reason (and an optional version), then the cut-off accepted
// on step 2. Only the first pass through step 2 needs the checkbox; a later pass
// keeps it, as the owner has already accepted it.
async function toCheckStep(dialog: Locator, accept: boolean) {
  await dialog.getByRole("button", { name: "Continue" }).click();
  if (accept)
    await dialog.getByLabel(/I understand Laptop will be cut off/).check();
  await dialog.getByRole("button", { name: "Continue" }).click();
}

export async function runRestoreScenario(harness: Harness, viewport: Viewport) {
  const stub = workspaceStub();
  const { context, page } = await open(harness, viewport);
  try {
    await serveWorkspace(page, stub, harness.password);
    await openWorkspace(page, harness);
    const laptop = page.getByRole("article", { name: "Client Laptop" });

    // Request backup: one flag, no password, and the button then waits.
    await laptop.getByRole("button", { name: "Request backup" }).click();
    await expect(
      laptop.getByText(/Asked Laptop to back up at its next sync/),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.backupRequests).toEqual(["ws-laptop"]);
    await expect(
      laptop.getByRole("button", { name: "Request backup" }),
    ).toBeDisabled();

    // Step 1: the reason is required before Continue, and no password is asked yet.
    await laptop.getByRole("button", { name: "Restore Laptop…" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore Laptop" });
    await expect(dialog.getByText("Step 1 of 3")).toBeVisible();
    const next = dialog.getByRole("button", { name: "Continue" });
    await expect(next).toBeDisabled();
    await dialog
      .getByLabel(/Why are you restoring/)
      .fill("Laptop disk replaced");
    await expect(next).toBeEnabled();
    await expect(dialog.getByLabel("Owner password")).toHaveCount(0);

    // Step 2: what will happen. Continue waits for the cut-off to be accepted.
    await next.click();
    await expect(dialog.getByText("Step 2 of 3")).toBeVisible();
    await expect(
      dialog.getByText(/The backup goes to a fresh device/),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Laptop is cut off from this server/),
    ).toBeVisible();
    await expect(next).toBeDisabled();
    await dialog.getByLabel(/I understand Laptop will be cut off/).check();
    await next.click();

    // Step 3: a wrong password is refused, and nothing is read.
    await expect(dialog.getByText("Step 3 of 3")).toBeVisible();
    const check = dialog.getByRole("button", { name: "Check the backup" });
    await expect(check).toBeDisabled();
    await dialog.getByLabel("Owner password").fill("not the owner password");
    await expect(check).toBeEnabled();
    await check.click();
    await expect(
      dialog.getByText(
        "That owner password was not accepted. Nothing was read.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.previews).toEqual([]);

    // The right password reads the backup: its version, size and check, and its
    // files under Details.
    await dialog.getByLabel("Owner password").fill(harness.password);
    await check.click();
    await expect(dialog.getByText(/Version 7, taken/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog.getByText("Verified", { exact: true })).toBeVisible();
    await dialog.getByText(/^Files in this backup/).click();
    await expect(
      dialog.getByRole("cell", { name: "settings.json" }),
    ).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "2.0 KB" })).toBeVisible();
    await expect(
      dialog.getByRole("row", { name: /live\/sessions\.json/ }),
    ).toContainText("Not restored");
    expect(stub.previews).toEqual([
      { client: "ws-laptop", reason: "Laptop disk replaced" },
    ]);
    expect(page.url()).not.toContain(harness.password);

    // The restore needs the password again: the check cleared it.
    const restore = dialog.getByRole("button", {
      name: "Restore and cut off Laptop",
    });
    await expect(restore).toBeDisabled();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(restore).toBeEnabled();
    await restore.click();

    // The dialog keeps its place and changes to the one-time code. Its name changes,
    // so the code is read from the one open dialog, not by its old name.
    const code = page.getByRole("dialog");
    await expect(
      code.getByRole("heading", { name: "Code for the fresh device" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(code.getByLabel("Restore code")).toHaveText(RESTORE_CODE);
    await expect(code.getByText(/It works once/)).toBeVisible();
    await expect(code.getByText(/Laptop is cut off/)).toBeVisible();
    expect(stub.restores).toEqual([
      { client: "ws-laptop", seq: 7, reason: "Laptop disk replaced" },
    ]);
    await expect(
      page.getByRole("article", { name: "Client Laptop" }),
    ).toHaveCount(0, { timeout: 10_000 });

    // Escape does not close the dialog while the code is on screen.
    await page.keyboard.press("Escape");
    await expect(code).toBeVisible();
    await code.getByRole("button", { name: "I have entered it" }).click();
    await expect(code).toHaveCount(0);
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
  await runUnverifiedRestore(harness, viewport);
  await runVersionPick(harness, viewport);
}

// Choosing an older version: a bad number is refused on the page before Continue, a
// number the server does not hold is refused by the server at the check, and the
// version that is checked is the one restored.
async function runVersionPick(harness: Harness, viewport: Viewport) {
  const stub = workspaceStub();
  const { context, page } = await open(harness, viewport);
  try {
    await serveWorkspace(page, stub, harness.password);
    await openWorkspace(page, harness);
    await page
      .getByRole("article", { name: "Client Laptop" })
      .getByRole("button", { name: "Restore Laptop…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Restore Laptop" });
    const next = dialog.getByRole("button", { name: "Continue" });
    const version = dialog.getByLabel("Backup version");
    await dialog
      .getByLabel(/Why are you restoring/)
      .fill("Laptop disk replaced");

    // Only a positive whole number is sent. Anything else is refused on the page.
    for (const bad of ["0", "1.5", "-1", "1e3", "seven"]) {
      await version.fill(bad);
      await expect(
        dialog.getByText(/Version must be a whole number, 1 or more/),
      ).toBeVisible();
      await expect(next).toBeDisabled();
    }
    expect(stub.previews).toEqual([]);

    // A number the server does not hold is refused by the server, at the check.
    await version.fill("9");
    await toCheckStep(dialog, true);
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Check the backup" }).click();
    await expect(
      dialog.getByText("No backup at seq 9 for that client"),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.previews).toEqual([]);

    // A held version is checked: that version, its own size, and the others as
    // choices. Back twice returns to the first step, where the number is typed.
    // Exact names: "Check the backup" also contains "back".
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await version.fill("6");
    await toCheckStep(dialog, false);
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Check the backup" }).click();
    // Older versions in the stub are smaller: 2.0 KB, not the latest's 4.0 KB.
    await expect(dialog.getByText(/Version 6, taken .*2\.0 KB/)).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.previews).toEqual([
      { client: "ws-laptop", reason: "Laptop disk replaced", seq: 6 },
    ]);

    // Another held version goes back to the first step with its number filled in.
    await dialog.getByRole("button", { name: "Use version 7 instead" }).click();
    await expect(version).toHaveValue("7");
    await toCheckStep(dialog, false);
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Check the backup" }).click();
    await expect(dialog.getByText(/Version 7, taken/)).toBeVisible({
      timeout: 10_000,
    });

    // The oldest version is restored, and that is the version that was checked.
    await dialog.getByRole("button", { name: "Use version 5 instead" }).click();
    await expect(version).toHaveValue("5");
    await toCheckStep(dialog, false);
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Check the backup" }).click();
    await expect(dialog.getByText(/Version 5, taken/)).toBeVisible({
      timeout: 10_000,
    });
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog
      .getByRole("button", { name: "Restore and cut off Laptop" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Code for the fresh device" }),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.restores).toEqual([
      { client: "ws-laptop", seq: 5, reason: "Laptop disk replaced" },
    ]);
    expect(stub.previews.map((item) => item.seq)).toEqual([6, 7, 5]);
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// A backup that does not verify is shown as such, and cannot be restored.
async function runUnverifiedRestore(harness: Harness, viewport: Viewport) {
  const stub: WorkspaceStub = { ...workspaceStub(), restoreVerified: false };
  const { context, page } = await open(harness, viewport);
  try {
    await serveWorkspace(page, stub, harness.password);
    await openWorkspace(page, harness);
    await page
      .getByRole("article", { name: "Client Laptop" })
      .getByRole("button", { name: "Restore Laptop…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Restore Laptop" });
    await dialog
      .getByLabel(/Why are you restoring/)
      .fill("Checking the backup");
    await toCheckStep(dialog, true);
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Check the backup" }).click();

    await expect(dialog.getByText("Not verified", { exact: true })).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(
      dialog.getByText(/does not pass its check, so it cannot be restored/),
    ).toBeVisible();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(
      dialog.getByRole("button", { name: "Restore and cut off Laptop" }),
    ).toBeDisabled();
    expect(stub.restores).toEqual([]);
    expect(stub.removed).toEqual([]);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
