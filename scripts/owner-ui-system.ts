// Browser checks for the owner panel's System view: homectl update status (homelab
// #21 §8). The real broker answers the update route; the stubs cover the other
// answers it can give (no route, a failed signature, a blocked install with its
// reason, and a verified install that the owner confirms with the password).

import { expect, type Page } from "@playwright/test";
import {
  type Harness,
  type Json,
  noOverflow,
  open,
  signIn,
  type VIEWPORTS,
} from "./owner-ui-harness";

type Viewport = (typeof VIEWPORTS)[number];

// Real broker, running from a source checkout: the status says why the panel
// cannot apply an update, and offers no Update button.
async function runRealBroker(harness: Harness, viewport: Viewport) {
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    await expect(
      page.getByText(/This broker runs from a source checkout/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(
      0,
    );
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// A broker without the update route (404): status only, and the panel says so.
async function runNoRoute(harness: Harness, viewport: Viewport) {
  const { context, page } = await open(harness, viewport);
  try {
    await page.route("**/v1/owner/update/**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 2, message: "Not found" } }),
      }),
    );
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(
      page.getByText(/does not report update status yet/),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(
      0,
    );
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// The broker's status, as the update route answers it. `updates` records each
// apply request the panel sends.
async function stubStatus(
  page: Page,
  status: Json,
  updates: Json[],
): Promise<void> {
  await page.route("**/v1/owner/update/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ current: "0.3.0", ...status }),
      });
    updates.push((route.request().postDataJSON() ?? {}) as Json);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "staged", next: "Restart to load it." }),
    });
  });
}

// Signature verified and installable: the owner confirms the exact version with
// the password, and the password is sent, not kept.
async function runVerifiedUpdate(harness: Harness, viewport: Viewport) {
  const updates: Json[] = [];
  const { context, page } = await open(harness, viewport);
  try {
    await stubStatus(
      page,
      {
        latest: "0.3.1",
        available: true,
        signature: "verified",
        canApply: true,
      },
      updates,
    );
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(page.getByText("homectl 0.3.0").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Signature verified")).toBeVisible();
    await page.getByRole("button", { name: "Update to 0.3.1…" }).click();
    const install = page.getByRole("button", { name: "Update homectl" });
    await expect(install).toBeDisabled();
    await page.getByLabel("Owner password").fill(harness.password);
    await expect(install).toBeEnabled();
    await install.click();
    await expect(
      page.getByText(/Update to 0\.3\.1 requested \(staged\)/),
    ).toBeVisible({ timeout: 10_000 });
    // The owner confirmed one exact version; the password is sent, not kept.
    expect(updates).toEqual([{ version: "0.3.1", password: harness.password }]);
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// A failed signature offers no Update action at all.
async function runFailedSignature(harness: Harness, viewport: Viewport) {
  const updates: Json[] = [];
  const { context, page } = await open(harness, viewport);
  try {
    await stubStatus(
      page,
      {
        latest: "0.3.1",
        available: true,
        signature: "failed",
        canApply: true,
      },
      updates,
    );
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(page.getByText("Signature check failed")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(/did not verify/)).toBeVisible();
    expect(updates).toEqual([]);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// A blocked install: the broker's reason is shown as text, and no Update button
// is offered for it.
async function runBlockedWithReason(harness: Harness, viewport: Viewport) {
  const updates: Json[] = [];
  const reason =
    "A package manager owns this install. Update it with that package manager.";
  const { context, page } = await open(harness, viewport);
  try {
    await stubStatus(
      page,
      {
        latest: "0.3.1",
        available: true,
        signature: "verified",
        canApply: false,
        reason,
      },
      updates,
    );
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(page.getByText(reason)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(
      0,
    );
    expect(updates).toEqual([]);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// System: every update answer the panel can show, at one viewport.
export async function runSystemScenario(harness: Harness, viewport: Viewport) {
  await runRealBroker(harness, viewport);
  await runNoRoute(harness, viewport);
  await runVerifiedUpdate(harness, viewport);
  await runFailedSignature(harness, viewport);
  await runBlockedWithReason(harness, viewport);
}
