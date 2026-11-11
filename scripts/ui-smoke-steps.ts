// Steps of the UI smoke test that are shared by several flows.
import { expect, type Page } from "@playwright/test";

// Every Execute button must sit inside the table card, with no clipping, at
// the desktop widths. Clipping or overflow fails the smoke run.
export async function assertExecuteInsideCard(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-table]");
    if (!card) return { error: "no table card" };
    const box = card.getBoundingClientRect();
    const buttons = [
      ...document.querySelectorAll<HTMLElement>(
        'button[data-action="control-execute"]',
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
  expect(report.outside, `${label}: Execute outside card`).toBe(0);
  expect(report.overflowsX, `${label}: table scrolls sideways`).toBe(false);
}

// Deny: a ready inspection is closed without running. Cancel keeps it; Deny with
// confirmation closes it as denied, so it can never run afterwards.
export async function denyReadyRequest(
  page: Page,
  plan: () => Promise<unknown>,
) {
  await plan();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: /^Ready to run/ }).click();
  const denied = page.locator("tr", { hasText: "uptime" });
  await denied.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog button[value=cancel]").click();
  await expect(page.locator("#confirm-dialog")).toHaveCount(0);
  await expect(
    denied.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await denied.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog button[value=confirm]").click();
  await expect(page.locator("#control-live")).toContainText("Request denied.");
  await expect(page.locator("tr", { hasText: "uptime" })).toHaveCount(0);
  await page.getByRole("button", { name: /^History/ }).click();
  await expect(
    page.locator("tr", { hasText: "uptime" }).getByText("denied"),
  ).toBeVisible();
}
