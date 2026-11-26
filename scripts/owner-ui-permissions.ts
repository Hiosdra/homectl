// Browser check for the Permissions wording (homelab #21, owner panel for average
// users). The default view reads in plain words: no risk codes, scopes, endpoints,
// identifiers or other jargon are visible. Under Details, and under Advanced, the
// technical names are there, each with a short explanation.

import { expect } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  open,
  signIn,
  type VIEWPORTS,
} from "./owner-ui-harness";

type Viewport = (typeof VIEWPORTS)[number];

// Words that must not show in the default view. The unit test
// (tests/owner-ui-permissions.test.ts) keeps the same list for the copy.
const JARGON = [
  /\bR[0-4]\b/,
  /\bscopes?\b/i,
  /\bendpoints?\b/i,
  /\bidentifiers?\b/i,
  /\breviewer\b/i,
  /\bpresets?\b/i,
  /\brevision\b/i,
  /\bargv/i,
  /\bhard gates?\b/i,
  /\bbudgets?\b/i,
  /\bkinds?\b/i,
  /\bclients?\b/i,
  /\bhosts?\b/i,
  /\bclassifications?\b/i,
  /\bmaxRisk\b/,
  /\bexec\b/i,
];

export async function runPermissionsWordingScenario(
  harness: Harness,
  viewport: Viewport,
) {
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    await page
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Who can do what on your machines?" }),
    ).toBeVisible({ timeout: 10_000 });
    // One plain sentence per assistant and machine, once the broker has answered.
    await expect(
      page
        .getByText(/(can look around|asks you before it looks around) on pc/)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // The default view, as a person reads it. Hidden text (Details, Why?,
    // Advanced) is not part of innerText, so only what is shown is checked.
    // biome-ignore lint/performance/useDomNodeTextContent: visible text is what a person reads; textContent would include the hidden Details
    const shown = await page.locator("main").innerText();
    expect(shown).toContain("When does homectl ask you first?");
    expect(shown).toContain("Ask me first");
    for (const word of JARGON) expect(shown).not.toMatch(word);

    // Details: the technical names are there, each with its explanation.
    const details = page.locator("details.details");
    await expect(details.getByText("Risk levels")).toBeHidden();
    await page.locator("details.details > summary").click();
    // biome-ignore lint/performance/useDomNodeTextContent: the opened Details must be read as shown
    const opened = await details.innerText();
    for (const term of [
      "R0",
      "R2",
      "R4",
      "Revision",
      "Stored as",
      "Address (endpoint)",
      "Task (scope)",
      "Limits (budgets)",
    ])
      expect(opened).toContain(term);
    await expect(details.getByLabel("Assistant")).toBeVisible();
    await expect(details.getByLabel("Machine")).toBeVisible();

    // Picking an AI choice while no helper is set up opens "Connect your AI
    // helper" at once (0.3). Nothing is saved; Escape keeps "Ask me first". The
    // helper's address fields are checked where a helper is ready, in the
    // Auto Mode and onboarding scenarios.
    await page.getByLabel(/AI helps with small fixes/).click();
    await expect(
      page.getByRole("dialog", { name: "Connect your AI helper" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel(/Ask me first/)).toBeChecked();
    await noOverflow(page);
  } finally {
    await context.close();
  }
  await runManualModeOption(harness, viewport);
}

// The quiet option under Advanced saves the broker's manual mode through the Auto Mode
// route. The route is answered here (not the real broker, so the shared owner state is
// untouched): refused without the password, saved with it, and the password is never
// in the body of the first try.
async function runManualModeOption(harness: Harness, viewport: Viewport) {
  const { context, page } = await open(harness, viewport);
  try {
    const sent: Record<string, unknown>[] = [];
    await page.route("**/v1/owner/auto-mode/set", (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<
        string,
        unknown
      >;
      sent.push(body);
      if (body.password === undefined)
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: 3, message: "Confirm with the owner password" },
          }),
        });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: 99,
          mode: "manual",
          reviewer: {
            authority: "recommend",
            fallback: "ask",
            maxRisk: "R2",
            apiKeyConfigured: false,
            ready: false,
          },
        }),
      });
    });
    await signIn(page, harness);
    await page
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "How much should homectl decide?" }),
    ).toBeVisible({ timeout: 10_000 });

    // Closed at first: the option is inside Advanced, under the three choices.
    const option = page.getByRole("button", {
      name: "Ignore my saved rules and ask about every change",
    });
    const advanced = page.locator("details.advanced", {
      hasText: "Ignore my saved rules",
    });
    await expect(option).toHaveCount(0);
    await advanced.locator("summary").click();
    await expect(option).toBeVisible();

    // Without the password the broker refuses: the password is asked for here.
    await option.click();
    await expect(
      page.getByText(/This change needs your owner password/),
    ).toBeVisible({ timeout: 10_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ mode: "manual" });
    expect(sent[0]).not.toHaveProperty("password");
    await advanced.getByLabel("Owner password").fill(harness.password);
    await option.click();
    await expect(
      page.getByText("Saved. Every change now waits for you."),
    ).toBeVisible({ timeout: 10_000 });
    expect(sent[1]).toMatchObject({
      mode: "manual",
      password: harness.password,
    });
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
