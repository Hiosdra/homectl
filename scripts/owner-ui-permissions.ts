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

    // The AI helper's address and model sit behind Advanced, closed at first.
    // The AI helper section appears for the AI choices; picking one shows it (no save).
    await page.getByLabel(/AI helps with small fixes/).check();
    const advanced = page.locator("details.advanced");
    await expect(
      advanced.getByText("AI helper address (endpoint)"),
    ).toBeHidden();
    await advanced.locator("summary").click();
    await expect(
      advanced.getByText("AI helper address (endpoint)"),
    ).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
