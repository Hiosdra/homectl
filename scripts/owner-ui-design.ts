// Browser checks for the owner panel's design: the information architecture (the
// nav order and where it sits), an accessibility pass that needs no extra
// dependency (labelled controls, named buttons, heading levels that never skip),
// the one-tap approval from the list, and the remembered section, which never
// opens over a waiting request. Each scenario uses its own request, by label.

import { expect, type Browser, type Page } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  signIn,
  VIEWPORTS,
} from "./owner-ui-harness";
import { approvalItem } from "./owner-ui-waiting";

// Controls that a screen reader could not name. Empty when every one has a label.
async function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const missing: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>("input, select, textarea"),
    )) {
      if (!visible(el) || (el as HTMLInputElement).type === "hidden") continue;
      const named =
        (el as HTMLInputElement).labels?.length ||
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby");
      if (!named) missing.push(el.id || el.getAttribute("name") || el.tagName);
    }
    return missing;
  });
}

async function unnamedButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button"))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .filter(
        (el) =>
          (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === "",
      )
      .map((el) => el.outerHTML.slice(0, 80)),
  );
}

// Heading levels start at 1 and never jump by more than one level.
async function headingProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const levels = Array.from(
      document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
    ).map((el) => ({
      level: Number(el.tagName.slice(1)),
      text: (el.textContent ?? "").trim(),
    }));
    const problems: string[] = [];
    let previous = 0;
    for (const heading of levels) {
      if (previous === 0 && heading.level !== 1)
        problems.push(`first heading is h${heading.level} "${heading.text}"`);
      else if (heading.level > previous + 1)
        problems.push(`h${heading.level} "${heading.text}" after h${previous}`);
      previous = heading.level;
    }
    return problems;
  });
}

async function runDesignScenario(
  harness: Harness,
  browser: Browser,
  viewport: (typeof VIEWPORTS)[number],
) {
  const context = await browser.newContext({
    viewport: viewport.viewport,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  const page = await context.newPage();
  try {
    await signIn(page, harness);

    // Information architecture: the owner's order, and the same order on both
    // layouts. Only the owner's own sections are offered.
    const nav = page.getByRole("navigation", { name: "Owner sections" });
    const names = await nav.getByRole("button").allTextContents();
    const order = ["Needs you", "Assistants", "Permissions", "System"].map(
      (label) => names.findIndex((name) => name.startsWith(label)),
    );
    expect(
      order.every((index) => index >= 0),
      names.join(" | "),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Layout: a bottom tab bar on a phone, a sidebar on a desktop.
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    if (viewport.mobile) {
      const bottom = (box?.y ?? 0) + (box?.height ?? 0);
      expect(
        Math.abs(bottom - (viewport.viewport.height ?? 0)),
        "tab bar sits on the bottom edge",
      ).toBeLessThanOrEqual(1);
    } else {
      expect(box?.x ?? 1).toBeLessThanOrEqual(1);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(200);
    }

    // Accessibility, without an extra dependency: every field is labelled, every
    // button has a name, and headings never skip a level.
    expect(await unlabelledControls(page)).toEqual([]);
    expect(await unnamedButtons(page)).toEqual([]);
    expect(await headingProblems(page)).toEqual([]);

    // One-tap approval from the list: a small change, no password, approved from
    // the card. The toast names the result and the command is run.
    const label = `design-${viewport.name}`;
    const argv = ["systemctl", "restart", label];
    await harness.requestCommand(argv);
    const card = approvalItem(page, argv);
    await expect(
      card.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => harness.ranCommands().at(-1), { timeout: 15_000 })
      .toEqual(argv);

    // The remembered section never opens over a waiting request: with one waiting,
    // the panel opens on "Needs you" even though the owner last used System.
    const waiting = `${label}-waiting`;
    const waitingArgv = ["systemctl", "restart", waiting];
    await harness.requestCommand(waitingArgv);
    await page.goto(`${harness.panelOrigin}/#/system`);
    await expect(
      page.getByRole("heading", { name: "System", exact: true }),
    ).toBeVisible();
    await page.goto(`${harness.panelOrigin}/`);
    await expect(
      page.getByRole("heading", { name: "Needs you", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Clean up what this scenario left waiting, then check nothing is waiting.
    const leftover = approvalItem(page, waitingArgv);
    await leftover.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(leftover).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(() => harness.waitingOnBroker(), { timeout: 15_000 })
      .toBe(0);

    // With nothing waiting, the section last used opens again. Only its name is
    // stored, never a token or a secret.
    await page.goto(`${harness.panelOrigin}/#/policy`);
    await expect(
      page.getByRole("heading", { name: "Permissions", exact: true }),
    ).toBeVisible();
    await page.goto(`${harness.panelOrigin}/`);
    await expect(
      page.getByRole("heading", { name: "Permissions", exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    const stored = await page.evaluate(() =>
      localStorage.getItem("homectl.owner.lastSection"),
    );
    expect(stored).toBe("policy");
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// Every design check at both viewports, against the real broker.
export async function runDesignScenarios(harness: Harness) {
  for (const viewport of VIEWPORTS) {
    await runDesignScenario(harness, harness.browser, viewport);
  }
}
