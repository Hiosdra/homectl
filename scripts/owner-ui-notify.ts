// Browser checks for browser notifications in the owner panel (homelab #21 §8):
// a browser that grants permission gets one alert per new request, and a
// browser that denies it gets none.

import { expect } from "@playwright/test";
import {
  type Harness,
  type Json,
  noOverflow,
  open,
  signIn,
  type VIEWPORTS,
} from "./owner-ui-harness";
import {
  approvalItem,
  openSecret,
  settledWaitingCount,
} from "./owner-ui-waiting";

// Notifications: a browser that grants permission gets one alert per new
// request; a browser that denies it gets none. The fake only records calls;
// it stands in for the OS, which a headless browser cannot show.
export async function runNotificationScenario(
  harness: Harness,
  viewport: (typeof VIEWPORTS)[number],
  answer: "granted" | "denied",
) {
  const { context, page } = await open(harness, viewport, {
    arg: { answer },
    script: ({ answer }) => {
      const notes: Json[] = [];
      Object.defineProperty(window, "__notes", { value: notes });
      let permission = "default";
      class FakeNotification {
        static get permission() {
          return permission;
        }
        static requestPermission() {
          permission = answer;
          return Promise.resolve(permission);
        }
        onclick: (() => void) | null = null;
        constructor(title: string, options: Json = {}) {
          notes.push({ title, body: options.body, tag: options.tag });
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", {
        value: FakeNotification,
        configurable: true,
      });
    },
  });
  try {
    await signIn(page, harness);
    await page.getByRole("button", { name: "System" }).click();
    await expect(
      page.getByRole("button", { name: "Turn on notifications" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Turn on notifications" }).click();
    if (answer === "granted") {
      await expect(page.getByText("On", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
    } else {
      await expect(
        page.getByText(/Notifications are blocked for this site/),
      ).toBeVisible({
        timeout: 10_000,
      });
    }

    // A request created after sign-in is announced (or not, when denied).
    // Labels are per run: an identical pending request would be deduplicated.
    const label = `alert-${answer}-${viewport.name}`;
    const before = await settledWaitingCount(page, harness);
    const argv = ["smoke-tool", "--apply", label];
    await harness.requestApproval(label);
    // A label keeps this request from matching a pending one left by an
    // earlier run: the broker returns the existing request for an identical one.
    const secret = await harness.requestSecret(`${answer}-${viewport.name}`);
    await page.getByRole("button", { name: "Needs you" }).click();
    // This run's own approval, not the first one on the page.
    await expect(
      approvalItem(page, argv).getByRole("button", { name: "Review" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    if (answer === "granted") {
      // Titles are polled so a miss reports what did arrive.
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (window as unknown as { __notes: Json[] }).__notes.map(
                (note) => note.title,
              ),
            ),
          { timeout: 10_000 },
        )
        .toEqual(
          expect.arrayContaining(["Approval needed", "Secret requested"]),
        );
      const again = await page.evaluate(
        () => (window as unknown as { __notes: Json[] }).__notes,
      );
      // One alert per request: the same canonical key never repeats.
      const tags = again.map((note) => note.tag);
      expect(new Set(tags).size).toBe(tags.length);
      // Notification text names the client and host only: no command, no
      // agent explanation, no secret value.
      const text = JSON.stringify(again);
      expect(text).not.toContain(label);
      expect(text).not.toMatch(/Apply |token|smoke-tool/);
    } else {
      const notes = await page.evaluate(
        () => (window as unknown as { __notes: Json[] }).__notes,
      );
      expect(notes).toEqual([]);
    }
    expect(page.url()).not.toMatch(/token|password|hco_/);
    // Clean up what this run left waiting: decline its secret request and deny its
    // approval, then check the broker is back where this run found it.
    await openSecret(page, secret.id, `${answer}-${viewport.name}`);
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    await page.getByRole("button", { name: "Needs you" }).click();
    await approvalItem(page, argv)
      .getByRole("button", { name: "Review" })
      .click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(() => harness.waitingOnBroker()).toBe(before);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
