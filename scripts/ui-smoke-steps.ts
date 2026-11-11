// Steps of the UI smoke test that are shared by several flows.
import { join } from "node:path";
import { type Browser, expect, type Page } from "@playwright/test";

// Screens the flow does not reach on its own, captured for comparison with the approved
// design: Settings, Welcome (same session cookie in a second tab), and the unlock screen
// from a browser with no session, at desktop and phone width.
export async function captureScreens(
  page: Page,
  browser: Browser,
  origin: string,
  out: string,
) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(out, "settings.png"), fullPage: true });
  // The panel follows the system theme; the approved mockup is shown dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: join(out, "settings-dark.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "light" });
  // The view comes from the hash at load time, so reload to open Welcome.
  await page.evaluate(() => {
    location.hash = "welcome";
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome to homectl", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(out, "welcome.png"), fullPage: true });
  // A new context has no session cookie, so the panel shows the unlock screen.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const locked = await context.newPage();
  await locked.goto(origin);
  await expect(
    locked.getByRole("heading", { name: "Unlock homectl", exact: true }),
  ).toBeVisible();
  await locked.screenshot({ path: join(out, "unlock.png"), fullPage: true });
  await locked.setViewportSize({ width: 390, height: 844 });
  await locked.screenshot({
    path: join(out, "unlock-mobile.png"),
    fullPage: true,
  });
  await context.close();
}

// Every row's Open button must sit inside the table card, with no clipping, at
// the desktop widths. Clipping or overflow fails the smoke run.
export async function assertOpenInsideCard(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-table]");
    if (!card) return { error: "no table card" };
    const box = card.getBoundingClientRect();
    const buttons = [
      ...document.querySelectorAll<HTMLElement>(
        'button[data-action="open-operation"]',
      ),
    ].map((b) => b.getBoundingClientRect());
    return {
      count: buttons.length,
      outside: buttons.filter((b) => b.left < box.left || b.right > box.right)
        .length,
      overflowsX: card.scrollWidth > card.clientWidth,
    };
  });
  expect(report, label).not.toHaveProperty("error");
  expect(report.count, label).toBeGreaterThan(0);
  expect(report.outside, `${label}: Open button outside card`).toBe(0);
  expect(report.overflowsX, `${label}: table scrolls sideways`).toBe(false);
}

// Machines: the row's ⋯ menu holds Edit; the side form then offers Remove.
export async function editMachine(page: Page, name: string) {
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: `More actions for ${name}` })
    .click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
}

// Approvals: Open a request row; its details panel holds Accept and Deny.
export async function openRequest(page: Page, rowText: string) {
  await page
    .locator("tr", { hasText: rowText })
    .getByRole("button", { name: "Open", exact: true })
    .click();
  return page.locator('aside[aria-label="Request details"]');
}

// Deny: a ready inspection is closed without running. Cancel keeps it; Deny with
// confirmation closes it as denied, so it can never run afterwards.
export async function denyReadyRequest(
  page: Page,
  plan: () => Promise<unknown>,
) {
  await plan();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  // The dashboard Review opens a request in Accept requests, with its row marked.
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Needs attention", exact: true }),
    })
    .getByRole("button", { name: "Review", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Accept requests", exact: true }),
  ).toBeVisible();
  await expect(page.locator("tr[data-operation]").first()).toBeVisible();
  await page.getByRole("tab", { name: /^To run/ }).click();
  const details = await openRequest(page, "uptime");
  await expect(
    details.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog button[value=cancel]").click();
  await expect(page.locator("#confirm-dialog")).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(page.locator("#control-live")).toContainText("Request denied.");
  await expect(page.locator("tr", { hasText: "uptime" })).toHaveCount(0);
  await page.getByRole("tab", { name: /^History/ }).click();
  await expect(
    page.locator("tr", { hasText: "uptime" }).getByText("denied"),
  ).toBeVisible();
}
