// Browser checks for the AI helper onboarding (0.3). The panel and the broker are
// real. The provider is a local stub server that serves /v1/models and the chat
// endpoint, reached through the Custom provider on loopback; nothing calls a real
// API. Checked: choosing an AI choice opens onboarding before anything is saved,
// Cancel and Escape keep "Ask me first", a missing key and an unreachable address
// give plain errors, the model list works (filter, Free, Custom model ID), the
// test passes, Connect needs the owner password, and the sheet's focus order.
// Set HOMECTL_UI_SHOTS to a folder to save light and dark screenshots of each step.

import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  open,
  signIn,
  VIEWPORTS,
} from "./owner-ui-harness";

const SHEET = "Connect your AI helper";
const MODELS = {
  data: [
    {
      id: "stub-fast",
      display_name: "Stub Fast",
      context_length: 128000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      description: "A quick stub model for the browser check.",
    },
    {
      id: "stub-free:free",
      name: "Stub Free",
      pricing: { prompt: "0", completion: "0" },
    },
  ],
};

// A local stand-in for an OpenAI-compatible server. It answers the same way a
// provider does: a model list, and one chat reply with a valid verdict.
export function startStubProvider(): { base: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/v1/models")
        return Response.json(MODELS);
      if (request.method === "POST" && pathname === "/v1/chat/completions")
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "ask", reason: "stub" }),
              },
            },
          ],
        });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}

// Saves light and dark screenshots of the current view when a folder is set.
// `atTop` is false when the caller has scrolled to the part it wants to show.
async function shots(page: Page, name: string, atTop = true) {
  const dir = process.env.HOMECTL_UI_SHOTS;
  if (!dir) return;
  // The sheet scrolls inside itself; by default the capture starts at its top,
  // and finished animations are waited for so the sheet is not caught half-open.
  if (atTop)
    await page
      .locator(".dialog-backdrop > div")
      .first()
      .evaluate((panel) => {
        panel.scrollTop = 0;
      });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: join(dir, `${name}-${scheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// The Permissions setting starts as "Ask me first" on a fresh broker. A run that
// follows another scenario sets it back first, with the owner password.
async function ensureAskFirst(page: Page, password: string) {
  const askFirst = page.getByLabel(/Ask me first/);
  if (await askFirst.isChecked()) return;
  await askFirst.check();
  await page.getByLabel(/Owner password/).fill(password);
  await page.getByRole("button", { name: "Save this setting" }).click();
  await expect(askFirst).toBeChecked({ timeout: 15_000 });
}

async function openPermissions(page: Page) {
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
}

// Desktop: the whole flow, from choosing an AI choice to a ready helper.
async function desktopFlow(
  harness: Harness,
  stubBase: string,
  viewport: (typeof VIEWPORTS)[number],
) {
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    await openPermissions(page);
    await ensureAskFirst(page, harness.password);
    const dialog = page.getByRole("dialog", { name: SHEET });

    // Choosing an AI choice opens onboarding at once, with focus on the first
    // control. Nothing is saved yet: the saved setting still reads "Ask me first".
    await page.getByLabel(/AI helps with small fixes/).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("radio", { name: "Anthropic" }),
    ).toBeFocused();
    await expect(page.getByLabel(/Ask me first/)).toBeChecked();

    await shots(page, "desktop-open");

    // Keyboard order: the provider choices are reached in turn with Tab.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("radio", { name: "OpenAI" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");

    // Anthropic with no key anywhere: a plain sentence, and no call to the provider.
    await dialog.getByRole("button", { name: "Refresh list" }).click();
    await expect(dialog.getByText(/Add the API key first/)).toBeVisible();
    await shots(page, "desktop-provider-no-key");

    // Cancel leaves the saved setting alone.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel(/Ask me first/)).toBeChecked();

    // Escape also cancels.
    await page.getByLabel(/AI helps with small fixes/).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel(/Ask me first/)).toBeChecked();

    // Custom with an unreachable address: the plain error names the address only.
    await page.getByLabel(/AI helps with small fixes/).click();
    await dialog.getByRole("radio", { name: "Custom" }).click();
    await dialog.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
    await dialog.getByRole("button", { name: "Refresh list" }).click();
    const plainError = dialog.getByText(/Could not reach 127\.0\.0\.1:9/);
    await expect(plainError).toBeVisible();
    await plainError.scrollIntoViewIfNeeded();
    await shots(page, "desktop-custom-error", false);

    // The stub provider: the list loads, then the free filter, then All again.
    await dialog.getByLabel("Base URL").fill(stubBase);
    await dialog.getByRole("button", { name: "Refresh list" }).click();
    await expect(
      dialog.getByRole("radio", { name: /stub-fast/ }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Free", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: /stub-fast/ })).toBeHidden();
    await expect(
      dialog.getByRole("radio", { name: /stub-free:free/ }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "All", exact: true }).click();
    await dialog.getByRole("radio", { name: /stub-fast/ }).check();
    await expect(dialog.getByText(/Selected:\s*stub-fast/)).toBeVisible();
    await shots(page, "desktop-custom-models");

    // The test call is harmless and reports ready.
    await dialog.getByRole("button", { name: "Test the connection" }).click();
    await expect(dialog.getByText("Your AI helper is ready.")).toBeVisible();

    // Connect stays off until the owner password is typed.
    const connect = dialog.getByRole("button", {
      name: "Connect",
      exact: true,
    });
    await expect(connect).toBeDisabled();
    await dialog.getByLabel(/Owner password/).fill(harness.password);
    await expect(connect).toBeEnabled();
    await shots(page, "desktop-confirm");
    await connect.click();

    // The saved setting and the helper's status both show the new state.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByLabel(/AI helps with small fixes/)).toBeChecked();
    const section = page.getByRole("region", { name: "The AI helper" });
    await section.locator("details.advanced summary").click();
    await expect(
      section.getByText(/Ready with Custom, model stub-fast/),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Change AI helper" }),
    ).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// Phone: a ready helper opens the same sheet full screen from Advanced.
async function phoneFlow(
  harness: Harness,
  viewport: (typeof VIEWPORTS)[number],
) {
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    await openPermissions(page);
    const section = page.getByRole("region", { name: "The AI helper" });
    await section.locator("details.advanced summary").click();
    await section.getByRole("button", { name: "Change AI helper" }).click();
    const dialog = page.getByRole("dialog", { name: SHEET });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio").first()).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(viewport.viewport.width - 1);
    expect(box?.height).toBeGreaterThanOrEqual(viewport.viewport.height - 1);
    await shots(page, "phone-sheet");
    await noOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
}

export async function runOnboardingScenarios(harness: Harness) {
  const desktop = VIEWPORTS.find((item) => item.name === "desktop");
  const phone = VIEWPORTS.find((item) => item.name === "phone");
  if (!desktop || !phone)
    throw new Error("The desktop and phone viewports are needed");
  const stub = startStubProvider();
  try {
    await desktopFlow(harness, stub.base, desktop);
    await phoneFlow(harness, phone);
  } finally {
    stub.stop();
  }
}
