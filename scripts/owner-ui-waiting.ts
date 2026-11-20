// Waiting-item helpers for the owner panel's browser checks. The broker is shared by
// every scenario in one run, so nothing here assumes the queue starts empty: each
// scenario finds its own request by its label or id, and takes a baseline count from
// the broker to check a delta.

import { expect, type Page } from "@playwright/test";
import type { Harness } from "./owner-ui-harness";

// The window title carries the panel's waiting count: "(N) homectl owner", or none at 0.
export function waitingFromTitle(title: string): number {
  return Number(/^\((\d+)\) homectl owner$/.exec(title)?.[1] ?? 0);
}

export function needsYouName(count: number): string {
  return count > 0 ? `Needs you ${count}` : "Needs you";
}

// The overview lists an approval as one item: "<argv> on <host>". Each scenario
// finds its own request by its argv, which carries the scenario's label.
export function approvalItem(page: Page, argv: string[]) {
  return page.locator("div.item").filter({ hasText: `${argv.join(" ")} on` });
}

// The panel shows an empty inbox until its first load, so a count read straight
// after sign-in can be 0 while the broker already holds requests. This waits until
// the panel's count agrees with the broker's own list, and returns that count as the
// baseline for a delta. Only for pages with no workspace stub: a stubbed workspace
// adds its own pending items to the panel's count.
export async function settledWaitingCount(
  page: Page,
  harness: Harness,
): Promise<number> {
  let expected = 0;
  await expect
    .poll(
      async () => {
        expected = await harness.waitingOnBroker();
        return waitingFromTitle(await page.title()) === expected;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return expected;
}

// Opens one secret request by its id, the way its "Provide or decline" button does.
// The detail view exists only once the panel has loaded the request, so this waits.
export async function openSecret(page: Page, id: string, label: string) {
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    `#/secrets/${encodeURIComponent(id)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Secret request" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`smoke tool-${label}`)).toBeVisible();
}
