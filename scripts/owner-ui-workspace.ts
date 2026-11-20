// Browser checks for the owner panel's workspace view (homelab #21 §6, §8): what a
// decision offers, step-up, removal and invite. The other owner checks live in
// owner-ui-restore.ts (backup and restore), owner-ui-auto-mode.ts (Auto Mode) and
// owner-ui-system.ts (updates); this file runs them all, one set per viewport.

import { expect } from "@playwright/test";
import { runAutoModeScenario } from "./owner-ui-auto-mode";
import { runNotificationScenario } from "./owner-ui-notify";
import { runRestoreScenario } from "./owner-ui-restore";
import { runSystemScenario } from "./owner-ui-system";
import {
  type Harness,
  noOverflow,
  open,
  serveWorkspace,
  signIn,
  VIEWPORTS,
  workspaceStub,
} from "./owner-ui-harness";

// Workspace views: clients, pending decisions (with step-up), removal, invite.
export async function runWorkspaceScenario(
  harness: Harness,
  viewport: (typeof VIEWPORTS)[number],
) {
  const stub = workspaceStub();
  const { context, page } = await open(harness, viewport);
  try {
    await serveWorkspace(page, stub, harness.password);
    await signIn(page, harness);

    // The workspace is offered because the server answers its routes.
    await expect(
      page.getByRole("button", { name: "Workspace (2)" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Review in Workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "Workspace" }),
    ).toBeVisible();

    // Requester text is shown as untrusted plain text.
    const normal = page
      .getByRole("article", { name: "Approval from Laptop" })
      .filter({ hasText: "fp-normal" });
    await expect(
      normal.getByText("<b>not bold</b>", { exact: false }),
    ).toBeVisible();
    await expect(normal.getByText(/not verified/)).toBeVisible();

    // Step-up: no approve button; the owner is told to approve on the device.
    const stepUp = page
      .getByRole("article", { name: "Approval from Laptop" })
      .filter({ hasText: "fp-stepup" });
    await expect(
      stepUp.getByText(/Approve it on its own device/),
    ).toBeVisible();
    await expect(
      stepUp.getByRole("button", { name: "Approve once" }),
    ).toHaveCount(0);
    await expect(
      stepUp.getByRole("button", { name: "Deny once" }),
    ).toBeVisible();

    // Approve once sends exactly the fingerprint and no password.
    await normal.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approval sent to the client/)).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.decisions.at(-1)).toEqual({
      client: "ws-laptop",
      operationId: "op-normal",
      fingerprint: "fp-normal",
      decision: "approve-once",
    });
    // A sent decision blocks a second one from this page.
    await expect(
      normal.getByRole("button", { name: "Approve once" }),
    ).toHaveCount(0);

    // Deny on the step-up operation is allowed and sends no password.
    await stepUp.getByRole("button", { name: "Deny once" }).click();
    await expect(page.getByText(/Denial sent to the client/)).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.decisions.at(-1)).toMatchObject({
      operationId: "op-stepup",
      decision: "deny-once",
    });
    expect(stub.decisions.at(-1)).not.toHaveProperty("password");

    // Clients: stale, approvals on device, vault, mirror gaps, backups.
    const nas = page.getByRole("article", { name: "Client NAS" });
    await expect(nas.getByText("Stale", { exact: true })).toBeVisible();
    await expect(nas.getByText("Approvals on its device")).toBeVisible();
    await expect(nas.getByText("2 gaps")).toBeVisible();
    await expect(nas.getByText("No backup yet")).toBeVisible();
    const laptop = page.getByRole("article", { name: "Client Laptop" });
    await expect(laptop.getByText("Recently synced")).toBeVisible();
    await expect(laptop.getByText("Vault unlocked")).toBeVisible();
    await expect(laptop.getByText("Sequence 42")).toBeVisible();

    // Remove NAS: the owner password is required, and it leaves the page.
    await nas.getByRole("button", { name: "Remove NAS…" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove NAS?" });
    const remove = dialog.getByRole("button", { name: "Remove client" });
    await expect(remove).toBeDisabled();
    await dialog.getByLabel("Owner password").fill(harness.password);
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(page.getByRole("article", { name: "Client NAS" })).toHaveCount(
      0,
      {
        timeout: 10_000,
      },
    );
    expect(stub.removed).toEqual(["ws-nas"]);

    // Invite: the one-time code and its expiry are shown once.
    await page.getByLabel("Owner password").fill(harness.password);
    await page.getByRole("button", { name: "Create invite code" }).click();
    await expect(page.getByLabel("Invite code")).toHaveText("K7Q-29X4", {
      timeout: 10_000,
    });
    await expect(
      page.getByText(/Shown once\. It admits one client/),
    ).toBeVisible();
    await page.getByRole("button", { name: "I have entered it" }).click();
    await expect(page.getByLabel("Invite code")).toHaveCount(0);
    expect(stub.invites).toBe(1);

    // No password ever reaches the address bar.
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// Every owner check, at both viewports. Each check starts from its own stubs.
export async function runOwnerExtensionScenarios(harness: Harness) {
  for (const viewport of VIEWPORTS) {
    await runWorkspaceScenario(harness, viewport);
    await runRestoreScenario(harness, viewport);
    await runAutoModeScenario(harness, viewport);
    await runSystemScenario(harness, viewport);
    await runNotificationScenario(harness, viewport, "granted");
    await runNotificationScenario(harness, viewport, "denied");
  }
}
