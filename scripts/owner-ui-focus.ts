// Keyboard checks for the owner panel: tab through each main screen and assert that
// the order is sensible (the sections first, then the screen's own controls, the
// password before the approve button, "More options" after the primary actions),
// that every stop is visible, and that every stop shows a focus ring. Each request
// this check creates is decided through the panel again, so it leaves nothing waiting.

import { expect, type Page } from "@playwright/test";
import { type Harness, open, signIn, VIEWPORTS } from "./owner-ui-harness";

type Viewport = (typeof VIEWPORTS)[number];

interface Stop {
  name: string;
  visible: boolean;
  ring: boolean;
}

// The next `count` real tab stops. Focus can leave the page for a press (back to
// the start, or the browser UI); those presses are skipped, not counted.
async function tabStops(page: Page, count: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (
    let attempt = 0;
    attempt < count * 3 && stops.length < count;
    attempt++
  ) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      // A form control is named by its label; a button by its own text.
      const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
      const name = (
        el.getAttribute("aria-label") ??
        labelled ??
        el.textContent ??
        el.tagName
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      return {
        name,
        visible: box.width > 0 && box.height > 0,
        ring:
          el.matches(":focus-visible") &&
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0,
      };
    });
    if (stop) stops.push(stop);
  }
  return stops;
}

// Every stop is on screen and carries a visible focus ring.
function expectRingedAndVisible(stops: Stop[], screen: string) {
  for (const stop of stops) {
    expect(stop.visible, `${screen}: "${stop.name}" is visible`).toBe(true);
    expect(stop.ring, `${screen}: "${stop.name}" shows a focus ring`).toBe(
      true,
    );
  }
}

// The index of the first stop whose name starts with `prefix`, or -1.
function indexOf(stops: Stop[], prefix: string): number {
  return stops.findIndex((stop) => stop.name.startsWith(prefix));
}

export async function runFocusScenario(harness: Harness, viewport: Viewport) {
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);

    // Needs you: the sections come first, in the order the owner reads them.
    const inbox = await tabStops(page, 12);
    expectRingedAndVisible(inbox, `${viewport.name} Needs you`);
    const sections = ["Needs you", "Assistants", "Permissions", "System"].map(
      (name) => indexOf(inbox, name),
    );
    expect(
      sections.every((index) => index >= 0),
      `${viewport.name} order: ${inbox.map((stop) => stop.name).join(" | ")}`,
    ).toBe(true);
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
    // A card's primary action follows its assistant's name and sentence.
    const approve = indexOf(inbox, "Approve");
    if (approve >= 0) expect(approve).toBeGreaterThan(sections[3] ?? 0);

    // An approval that needs the password: password, then approve, then the rest.
    const approval = await harness.requestApproval(`focus-${viewport.name}`);
    await page.evaluate((id) => {
      location.hash = `#/approvals/${encodeURIComponent(id)}`;
    }, approval.id);
    await expect(page.locator("#approval-title")).toBeVisible({
      timeout: 15_000,
    });
    await page.evaluate(() => document.querySelector("main")?.focus());
    const detail = await tabStops(page, 16);
    expectRingedAndVisible(detail, `${viewport.name} approval`);
    const password = indexOf(detail, "Owner password");
    // "Approve once" stays disabled until the password is typed, and a disabled
    // button takes no focus, so the order is checked on the controls that do.
    const deny = indexOf(detail, "Deny");
    const more = indexOf(detail, "More options");
    expect(password, "password is reached").toBeGreaterThanOrEqual(0);
    expect(password).toBeLessThan(deny);
    expect(deny).toBeLessThan(more);
    // Clear it through the panel: deny needs no password.
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Needs you", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // A secret request: the value fields, then the retention choice, then the password.
    const secret = await harness.requestSecret(`focus-${viewport.name}`);
    await page.evaluate((id) => {
      location.hash = `#/secrets/${encodeURIComponent(id)}`;
    }, secret.id);
    await expect(
      page.getByRole("heading", { name: "Secret request" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => document.querySelector("main")?.focus());
    const form = await tabStops(page, 14);
    expectRingedAndVisible(form, `${viewport.name} secret`);
    const value = indexOf(form, "API token");
    const keep = indexOf(form, "One hour");
    // "Provide secret" is disabled until the form is complete, so the order is
    // checked on the controls that take focus: value, retention, password, Decline.
    const passwordStep = indexOf(form, "Owner password");
    const decline = indexOf(form, "Decline");
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(keep);
    expect(keep).toBeLessThan(passwordStep);
    expect(passwordStep).toBeLessThan(decline);
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Needs you", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Assistants and Permissions: every stop visible and ringed, no trap.
    await page.getByRole("button", { name: /^Assistants/ }).click();
    await page
      .getByRole("heading", { name: "Assistants", exact: true })
      .waitFor();
    expectRingedAndVisible(
      await tabStops(page, 12),
      `${viewport.name} assistants`,
    );
    await page.getByRole("button", { name: /^Permissions/ }).click();
    await page
      .getByRole("heading", { name: "Permissions", exact: true })
      .waitFor();
    expectRingedAndVisible(
      await tabStops(page, 12),
      `${viewport.name} permissions`,
    );
  } finally {
    await context.close();
  }
}
