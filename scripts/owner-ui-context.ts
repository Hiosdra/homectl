// Browser checks for the owner panel's device context switcher (homelab #21 §8):
// the switcher is there and labelled, each context filters the inbox, approvals,
// machines and history, "Show all devices" goes back, the choice survives a
// reload, a stale choice never hides local items, and a broker with no workspace
// shows no switcher and no error. Runs at both viewports from owner-ui-workspace.

import { expect, type Page } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  open,
  serveWorkspace,
  signIn,
  workspaceStub,
} from "./owner-ui-harness";

// One of the harness's VIEWPORTS entries (desktop and phone).
type Viewport = {
  name: string;
  viewport: { width: number; height: number };
  mobile: boolean;
};

const STORAGE_KEY = "homectl.owner.context";
const LOCAL_TEXT = "smoke-tool --local";

// A local approval as the broker lists it on /v1/owner/pending.
function localOperation(id: string) {
  return {
    id,
    state: "pending",
    client: "codex",
    host: "pc",
    argv: ["smoke-tool", "--local"],
    classification: "inspection",
    risk: "R2",
    fingerprint: `fp-${id}`,
    decision: {
      verdict: "ask",
      source: "rule",
      reason: "Matches the maintenance rule",
      humanOnly: false,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60_000,
    narrative: { untrusted: "Check the local pool." },
  };
}

// Only this device's approvals and secret requests come from the local broker.
async function serveLocal(page: Page) {
  await page.route("**/v1/owner/pending", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([localOperation("op-local")]),
    }),
  );
  await page.route("**/v1/owner/secrets/pending", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );
}

async function storedContext(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

export async function runContextScenario(harness: Harness, viewport: Viewport) {
  // The stub has five Laptop approvals and two clients. Add one NAS approval
  // and let the NAS approve, so each filter has rows of its own.
  const stub = workspaceStub();
  const nas = stub.clients.find((client) => client.id === "ws-nas");
  if (nas) nas.remoteApproval = true;
  stub.pending.push({
    origin: "ws-nas",
    originName: "NAS",
    id: "op-nas",
    client: "codex",
    host: "pc",
    argv: ["zfs", "status"],
    risk: "R2",
    fingerprint: "fp-nas",
    reason: "Matches the maintenance rule",
    stepUp: false,
    humanOnly: false,
    expiresAt: Date.now() + 10 * 60_000,
    intent: null,
  });

  const { context, page } = await open(harness, viewport);
  try {
    await serveWorkspace(page, stub, harness.password);
    // Sign in against the real broker first: the stubs would answer the panel's
    // first, signed-out read. Then the local stub takes over and the page reloads.
    await signIn(page, harness);
    await serveLocal(page);
    await page.reload();
    await expect(page.getByText(LOCAL_TEXT)).toBeVisible({ timeout: 15_000 });

    // All devices is the default: the switcher is labelled and selected, and
    // the inbox holds this device's approval and the linked-client count.
    const switcher = page.getByRole("combobox", { name: "Devices" });
    await expect(switcher).toHaveValue("all");
    await expect(page.getByText(LOCAL_TEXT)).toBeVisible();
    await expect(
      page.getByText("6 approvals are waiting on a linked client."),
    ).toBeVisible();
    await expect(page.getByText(/^Showing /)).toHaveCount(0);

    // Keyboard: the switcher takes focus like any native select.
    await switcher.focus();
    await expect(switcher).toBeFocused();

    // NAS only: this device's approval leaves the inbox, the linked count narrows,
    // and the note says what is hidden.
    await switcher.selectOption({ label: "NAS" });
    await expect(switcher).toHaveValue("client:ws-nas");
    await expect(
      page.getByText(
        /^Showing NAS only\. 6 items on other devices are hidden\./,
      ),
    ).toBeVisible();
    await expect(page.getByText(LOCAL_TEXT)).toHaveCount(0);
    await expect(
      page.getByText("One approval is waiting on a linked client."),
    ).toBeVisible();
    expect(await storedContext(page)).toBe("client:ws-nas");
    // The choice lives in storage, never in the address bar.
    expect(page.url()).not.toMatch(/client:|ws-nas/);

    // The workspace follows the same choice: NAS rows, NAS machine, NAS history.
    await page.getByRole("button", { name: /^Devices & backup/ }).click();
    await expect(
      page.getByRole("heading", { name: "Devices & backup" }),
    ).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Approval from NAS" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("article", { name: "Approval from Laptop" }),
    ).toHaveCount(0);
    await expect(page.getByRole("article", { name: "Client NAS" })).toHaveCount(
      1,
    );
    await expect(
      page.getByRole("article", { name: "Client Laptop" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Recent decisions" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create invite code" }),
    ).toHaveCount(0);
    await expect(page.getByText(/^Showing NAS only\./)).toBeVisible();

    // Approve on the filtered view sends the same canonical identity as before.
    const nasItem = page.getByRole("article", { name: "Approval from NAS" });
    await nasItem.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approval queued for the client/)).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.decisions.at(-1)).toEqual({
      client: "ws-nas",
      operationId: "op-nas",
      fingerprint: "fp-nas",
      decision: "approve-once",
    });

    // One click back to All devices restores every row and clears the note.
    await page.getByRole("button", { name: "Show all devices" }).click();
    await expect(switcher).toHaveValue("all");
    await expect(
      page.getByRole("article", { name: "Approval from Laptop" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Client Laptop" }),
    ).toHaveCount(1);
    await expect(page.getByText(/^Showing /)).toHaveCount(0);
    expect(await storedContext(page)).toBe("all");

    // This device: nothing from linked clients, and the note says so.
    await switcher.selectOption({ label: "This device" });
    await expect(switcher).toHaveValue("local");
    await expect(
      page.getByRole("article", { name: /^Approval from/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/^Linked clients, their approvals and their history/),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Needs you/ }).click();
    await expect(page.getByText(LOCAL_TEXT)).toBeVisible();
    await expect(
      page.getByText(/^Showing This device only\. 6 items on other devices/),
    ).toBeVisible();
    await expect(
      page.getByText(/approvals? (is|are) waiting on a linked client/),
    ).toHaveCount(0);

    // The choice survives a reload: the same client is selected again.
    await switcher.selectOption({ label: "Laptop" });
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Devices" })).toHaveValue(
      "client:ws-laptop",
      { timeout: 15_000 },
    );
    await expect(page.getByText(/^Showing Laptop only\./)).toBeVisible();
    await expect(page.getByText(LOCAL_TEXT)).toHaveCount(0);

    // Everything is in this one panel: no workspace error, and no token or
    // password in the address bar.
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// A broker that is not a workspace server answers 404 on the workspace routes.
// The panel then offers no switcher and no workspace view, and a stale client
// choice from an earlier visit must not hide this device's approvals.
export async function runNoWorkspaceContext(
  harness: Harness,
  viewport: Viewport,
) {
  const { context, page } = await open(harness, viewport, {
    script: (value: string) => {
      try {
        localStorage.setItem("homectl.owner.context", value);
      } catch {
        // Storage is blocked: the panel must still work.
      }
    },
    arg: "client:ws-laptop",
  });
  try {
    await page.route("**/v1/owner/workspace/**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 2, message: "Not found" } }),
      }),
    );
    // Sign in first, then the local stub: see runContextScenario.
    await signIn(page, harness);
    await serveLocal(page);
    await page.reload();

    await expect(page.getByText(LOCAL_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("combobox", { name: "Devices" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: /^Devices & backup/ }),
    ).toHaveCount(0);
    await expect(page.getByText(/^Showing /)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
