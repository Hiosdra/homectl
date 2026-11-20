// Browser checks for backup requests and restores of a linked client (homelab #21
// §6). A request changes one flag. A restore shows its preview first, needs the
// password and a reason each time it is sent, revokes the client, and shows the
// one-time code until the owner confirms it was entered.

import { expect, type Page } from "@playwright/test";
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

    // Restore: the preview needs a reason and the password.
    await laptop.getByRole("button", { name: "Restore Laptop…" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore Laptop" });
    const preview = dialog.getByRole("button", { name: "Preview snapshot" });
    await expect(preview).toBeDisabled();
    await dialog.getByLabel("Reason").fill("Laptop disk replaced");
    await expect(preview).toBeDisabled();

    // A wrong password is refused, nothing is read, and the page says so.
    await dialog.getByLabel("Owner password").fill("not the owner password");
    await expect(preview).toBeEnabled();
    await preview.click();
    await expect(
      dialog.getByText(
        "That owner password was not accepted. Nothing was read.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.previews).toEqual([]);

    // The right password shows what the snapshot holds, sizes and version.
    await dialog.getByLabel("Owner password").fill(harness.password);
    await preview.click();
    await expect(dialog.getByText(/Version 7, taken/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog.getByText("Verified", { exact: true })).toBeVisible();
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

    // The restore is a second, separate confirmation, and it needs the password
    // again: the preview cleared it.
    const restore = dialog.getByRole("button", {
      name: "Restore and revoke Laptop",
    });
    await expect(restore).toBeDisabled();
    await dialog.getByLabel("I understand Laptop will be revoked").check();
    await expect(restore).toBeDisabled();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(restore).toBeEnabled();
    await restore.click();

    // The dialog keeps its place and changes its title to the code. Its name
    // changes, so the code is read from the one open dialog, not by its old name.
    const code = page.getByRole("dialog");
    await expect(
      code.getByRole("heading", { name: "Code for the fresh device" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(code.getByLabel("Restore code")).toHaveText(RESTORE_CODE);
    await expect(
      code.getByText(/Shown once\. It admits one fresh device and expires/),
    ).toBeVisible();
    await expect(code.getByText(/Laptop is revoked/)).toBeVisible();
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

// Choosing an older version: a bad number is refused on the page before anything
// is sent, a number the server does not hold is refused by the server, and the
// version that is previewed is the one restored.
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
    const preview = dialog.getByRole("button", { name: "Preview snapshot" });
    const version = dialog.getByLabel("Version");
    await dialog.getByLabel("Reason").fill("Laptop disk replaced");

    // Only a positive whole number is sent. Anything else is refused on the page.
    await dialog.getByLabel("Owner password").fill(harness.password);
    for (const bad of ["0", "1.5", "-1", "1e3", "seven"]) {
      await version.fill(bad);
      await expect(
        dialog.getByText(/Version must be a whole number, 1 or more/),
      ).toBeVisible();
      await expect(preview).toBeDisabled();
    }
    expect(stub.previews).toEqual([]);

    // A number the server does not hold is refused by the server, and the page
    // says so. The password was taken out of the form, so it is typed again.
    await version.fill("9");
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(preview).toBeEnabled();
    await preview.click();
    await expect(
      dialog.getByText("No backup at seq 9 for that client"),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.previews).toEqual([]);

    // A held version is previewed: that version, its own size, and the others as
    // choices.
    await version.fill("6");
    await dialog.getByLabel("Owner password").fill(harness.password);
    await preview.click();
    // Older versions in the stub are smaller: 2.0 KB, not the latest's 4.0 KB.
    await expect(dialog.getByText(/Version 6, taken .*2\.0 KB/)).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.previews).toEqual([
      { client: "ws-laptop", reason: "Laptop disk replaced", seq: 6 },
    ]);

    // Another held version goes back to the form with its number filled in.
    await dialog.getByRole("button", { name: "Preview version 7" }).click();
    await expect(version).toHaveValue("7");
    await dialog.getByLabel("Owner password").fill(harness.password);
    await preview.click();
    await expect(dialog.getByText(/Version 7, taken/)).toBeVisible({
      timeout: 10_000,
    });

    // The oldest version is restored, and that is the version that was previewed.
    await dialog.getByRole("button", { name: "Preview version 5" }).click();
    await expect(version).toHaveValue("5");
    await dialog.getByLabel("Owner password").fill(harness.password);
    await preview.click();
    await expect(dialog.getByText(/Version 5, taken/)).toBeVisible({
      timeout: 10_000,
    });
    await dialog.getByLabel("I understand Laptop will be revoked").check();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog
      .getByRole("button", { name: "Restore and revoke Laptop" })
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

// A snapshot that does not verify is shown as such, and cannot be restored.
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
    await dialog.getByLabel("Reason").fill("Checking the snapshot");
    await dialog.getByLabel("Owner password").fill(harness.password);
    await dialog.getByRole("button", { name: "Preview snapshot" }).click();

    await expect(dialog.getByText("Not verified", { exact: true })).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(
      dialog.getByText(/does not verify, so a restore would be refused/),
    ).toBeVisible();
    await dialog.getByLabel("I understand Laptop will be revoked").check();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(
      dialog.getByRole("button", { name: "Restore and revoke Laptop" }),
    ).toBeDisabled();
    expect(stub.restores).toEqual([]);
    expect(stub.removed).toEqual([]);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
