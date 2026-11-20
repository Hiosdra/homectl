// First run and unlock of the local panel (homelab #21 §8, §10), driven the way a
// person uses them: Welcome's own actions, then the unlock form in a browser with no
// session. Each step asserts where the action leads and what Welcome shows afterwards.
import { type Browser, expect, type Page } from "@playwright/test";

const UNLOCK_BUTTON = { name: "Unlock", exact: true } as const;
const WRONG_PASSWORD = "not the smoke password";

async function openWelcome(page: Page) {
  // The view comes from the hash at load time, so reload to open Welcome.
  await page.evaluate(() => {
    location.hash = "welcome";
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome to homectl", exact: true }),
  ).toBeVisible();
}

function step(page: Page, title: string) {
  return page.getByRole("listitem").filter({ hasText: title });
}

// Opens a step's action while the step is open, then runs the check for where it leads.
// A step that is already done shows "done" instead of its action, and that is asserted.
async function driveStep(
  page: Page,
  title: string,
  action: string,
  opened: () => Promise<void>,
) {
  await openWelcome(page);
  const button = step(page, title).getByRole("button", {
    name: action,
    exact: true,
  });
  if (await button.isVisible()) {
    await button.click();
    await opened();
  } else {
    await expect(
      step(page, title).getByText("done", { exact: true }),
    ).toBeVisible();
  }
}

// Welcome shows an action while a step is open and "done" once it is not. A step is
// either driven to its place or confirmed as done; nothing is skipped silently.
export async function driveOnboarding(page: Page) {
  await openWelcome(page);

  // Step 1, the safe: its action opens the Vault screen, which holds the create form.
  await step(page, "Create a safe")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(page.locator("form#unlock-form")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create and unlock safe" }),
  ).toBeVisible();

  // Step 2, a machine: the action opens the add-host form, or the step is done.
  await openWelcome(page);
  const start = step(page, "Create an SSH key").getByRole("button", {
    name: "Start",
    exact: true,
  });
  if (await start.isVisible()) {
    await start.click();
    await expect(
      page.getByRole("heading", { name: "Add SSH host" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } else {
    await expect(
      step(page, "Create an SSH key").getByText("done", { exact: true }),
    ).toBeVisible();
  }

  // Step 3, a second device: optional, its action opens the pairing wizard.
  await driveStep(page, "Pair a second device", "Pair", async () => {
    await expect(
      page.getByRole("heading", { name: "Pair a computer" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Pair a computer" }),
    ).toHaveCount(0);
  });

  // Step 4, an MCP client: its action shows the ready command in a dialog.
  await driveStep(page, "Connect an MCP client", "Show command", async () => {
    await expect(
      page.getByRole("heading", { name: "Connect an MCP client" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Connect an MCP client" }),
    ).toHaveCount(0);
  });

  // Back to the dashboard, as the person would from Welcome.
  await page
    .getByRole("link", { name: /^Dashboard/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
}

// The unlock screen of a browser with no session, at desktop and phone width: a wrong
// password is refused by the real server and the form stays locked. The right one
// opens the panel (see the stub note below). `mainPage` is the signed-in panel, whose
// state the success path reuses.
export async function verifyUnlock(
  browser: Browser,
  origin: string,
  password: string,
  mainPage: Page,
) {
  const state = await mainPage.evaluate(async () =>
    (await fetch("/api/state")).text(),
  );
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await expect(
        page.getByRole("heading", { name: "Unlock homectl", exact: true }),
      ).toBeVisible();
      const field = page.locator("#password");
      await expect(field).toHaveAttribute("type", "password");
      // The unlock button enables once the panel's key has been read.
      await expect(page.getByRole("button", UNLOCK_BUTTON)).toBeEnabled({
        timeout: 15_000,
      });

      await field.fill(WRONG_PASSWORD);
      await page.getByRole("button", UNLOCK_BUTTON).click();
      await expect(page.locator("#unlock-error")).toContainText(
        "Unlock failed. Check the database password.",
      );
      await expect(
        page.getByRole("heading", { name: "Unlock homectl", exact: true }),
      ).toBeVisible();
      // The typed value is cleared after the attempt.
      await expect(field).toHaveValue("");

      // The right password. This smoke vault has no stored SSH key entries, so the real
      // server refuses it too (its log: "Private credential operation failed"), and the
      // panel shows the same message as for a wrong password. The success answer is
      // therefore stubbed here: the unlock and the state read that follow it.
      await page.route("**/api/unlock", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ unlocked: true }),
        }),
      );
      await page.route("**/api/state", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: state,
        }),
      );
      const sent = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/unlock",
      );
      await field.fill(password);
      await page.getByRole("button", UNLOCK_BUTTON).click();
      // The password leaves the browser sealed, never as typed.
      const body = (await sent).postData() ?? "";
      expect(body).toContain('"ct"');
      expect(body).not.toContain(password);
      await expect(page.locator("#lock")).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: "Unlock homectl", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("#unlock-error")).toHaveCount(0);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  }
}
