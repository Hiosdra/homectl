// Owner panel flows against the real broker and a fake executor (homelab #21 §8,
// §10): remembering a rule, the attention inbox, and the live stream dropping and
// coming back. The panel and the broker are real; only the executor is fake, and no
// workspace route is stubbed here.

import { expect } from "@playwright/test";
import {
  type Harness,
  noOverflow,
  open,
  signIn,
  VIEWPORTS,
} from "./owner-ui-harness";
import {
  approvalItem,
  needsYouName,
  settledWaitingCount,
  waitingFromTitle,
} from "./owner-ui-waiting";

type Viewport = (typeof VIEWPORTS)[number];

// An unknown command is opaque and R3: the hard gate, so it can only be approved once.
const opaqueFor = (label: string) => ["smoke-tool", "--apply", label];
// A service restart is a mutation: R2 with no sudo. The policy asks, and the owner may
// remember the exact command.
const rememberableFor = (label: string) => ["systemctl", "restart", label];

// Remember: the owner approves once and remembers the exact command. The browser
// sends only the identity of the decision; the broker saves the exact rule.
export async function runRememberScenario(
  harness: Harness,
  viewport: Viewport,
) {
  const label = `remember-${viewport.name}`;
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    const before = await settledWaitingCount(page, harness);
    // Its own agent, so its risk budget holds only this scenario's requests.
    const agent = await harness.createAgent(`remember-${viewport.name}`);

    // Human-only: an opaque command never offers "remember", and says so.
    const opaque = await harness.requestCommandAs(agent, opaqueFor(label));
    expect(opaque.state).toBe("awaiting-approval");
    await approvalItem(page, opaqueFor(label))
      .getByRole("button", { name: "Review" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Approve this command?" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This kind of action can only be approved once. It cannot become a rule.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve and remember…" }),
    ).toHaveCount(0);
    // Clear it with a single approval so it does not linger in the inbox.
    await page.getByLabel("Owner password").fill(harness.password);
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approved\./).first()).toBeVisible({
      timeout: 15_000,
    });

    // Remember: the rule is for this exact command from this client on this host.
    const argv = rememberableFor(label);
    const requested = await harness.requestCommandAs(agent, argv);
    expect(requested.state).toBe("awaiting-approval");
    await approvalItem(page, argv)
      .getByRole("button", { name: "Review" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Approve this command?" }),
    ).toBeVisible();
    const remember = page.getByRole("button", {
      name: "Approve and remember…",
    });
    await expect(remember).toBeEnabled();
    await remember.click();

    // The dialog states the exact scope before anything is saved.
    const dialog = page.getByRole("dialog", { name: "Approve and remember?" });
    await expect(
      dialog.getByText(
        `Future commands exactly like "${argv.join(" ")}" on pc from ${agent.id} will run without asking. You can remove the rule in Permissions.`,
        { exact: true },
      ),
    ).toBeVisible();
    const decideSent = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/v1/owner/decide",
    );
    await dialog
      .getByRole("button", { name: "Approve and remember", exact: true })
      .click();
    const sent = (await decideSent).postDataJSON() as Record<string, unknown>;
    expect(sent).toMatchObject({
      operationId: requested.id,
      decision: "approve-remember",
    });
    expect(sent.fingerprint).toEqual(expect.any(String));
    // Only the decision identity leaves the browser: no rule, no scope, nothing that
    // could widen the saved rule.
    expect(Object.keys(sent).sort()).toEqual([
      "decision",
      "fingerprint",
      "operationId",
    ]);
    await expect(page.getByText(/Approved\./).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => harness.ranCommands().at(-1), { timeout: 15_000 })
      .toEqual(argv);

    // Another assistant, made before the panel loads its list, so the check can
    // pick it from the list and show the rule does not apply to it.
    const other = await harness.createAgent(`other-${label}`);

    // The saved rule is the exact request, in plain words: this command, this
    // assistant's machine, up to small changes. Its stored facts sit under Why?.
    await page
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    const rule = page
      .locator("tr")
      .filter({ hasText: `the exact command "systemctl restart ${label}"` });
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText("Allowed without asking");
    await expect(rule).toContainText("on pc, up to small, undoable changes");
    await rule.locator("details.why > summary").click();
    await expect(rule).toContainText(`Stored as clients.`);
    await expect(rule).toContainText("Stored as maxRisk.");
    const ruleId = (
      await rule.locator("dd.mono").first().textContent()
    )?.trim();
    expect(ruleId).toBeTruthy();

    // The check under Details reads the same rule, with the assistant and the
    // machine picked from lists.
    await page.locator("details.details > summary").click();
    const effective = page.locator("details.details");
    await effective.getByLabel("Assistant").selectOption(agent.id);
    await effective.getByLabel("Machine").selectOption("pc");
    await effective.getByRole("button", { name: "Check", exact: true }).click();
    await expect(
      effective.locator("li").filter({ hasText: ruleId ?? "" }),
    ).toContainText("this rule applies");
    await effective.getByLabel("Assistant").selectOption(other.id);
    await effective.getByRole("button", { name: "Check", exact: true }).click();
    await expect(
      effective.locator("li").filter({ hasText: ruleId ?? "" }),
    ).toContainText("this rule does not apply");

    // A matching later request runs with no approval; a longer command still asks.
    const again = await harness.requestCommandAs(agent, argv);
    expect(again.state).not.toBe("awaiting-approval");
    await expect
      .poll(() => harness.ranCommands().at(-1), { timeout: 15_000 })
      .toEqual(argv);
    const longer = await harness.requestCommandAs(agent, [...argv, "--extra"]);
    expect(longer.state).toBe("awaiting-approval");
    // Clean up what this scenario left waiting: deny the longer command, then check
    // the broker is back where this scenario found it. The inbox is on the overview,
    // not on the Permissions view this scenario ended on.
    await page.getByRole("button", { name: /^Needs you/ }).click();
    await approvalItem(page, [...argv, "--extra"])
      .getByRole("button", { name: "Review" })
      .click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(() => harness.waitingOnBroker()).toBe(before);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// The attention inbox: a request that arrives while the panel is open shows up
// without a reload, and acting on it clears it everywhere.
export async function runAttentionScenario(
  harness: Harness,
  viewport: Viewport,
) {
  const label = `attention-${viewport.name}`;
  const argv = opaqueFor(label);
  const { context, page } = await open(harness, viewport);
  try {
    await signIn(page, harness);
    await expect(
      page.locator("header").getByText("Live", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const before = await settledWaitingCount(page, harness);

    await harness.requestCommand(argv);
    await expect(approvalItem(page, argv)).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: needsYouName(before + 1), exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => waitingFromTitle(await page.title()))
      .toBe(before + 1);

    await approvalItem(page, argv)
      .getByRole("button", { name: "Review" })
      .click();
    await page.getByLabel("Owner password").fill(harness.password);
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.getByText(/Approved\./).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(approvalItem(page, argv)).toHaveCount(0);
    await expect
      .poll(async () => waitingFromTitle(await page.title()))
      .toBe(before);
    await expect(
      page.getByRole("button", { name: needsYouName(before), exact: true }),
    ).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
}

// Offline and reconnect: the event stream drops, the panel says so, a request made
// meanwhile is not shown until the panel catches up, and then it is shown once.
export async function runOfflineScenario(harness: Harness, viewport: Viewport) {
  const label = `offline-${viewport.name}`;
  const argv = opaqueFor(label);
  const { context, page } = await open(harness, viewport);
  const badge = page
    .locator("header")
    .getByText(/^(Live|Reconnecting|Offline|Connecting)$/);
  try {
    await signIn(page, harness);
    await expect(badge).toHaveText("Live", { timeout: 15_000 });
    const before = await settledWaitingCount(page, harness);

    // A route only sees new requests, and the open stream predates it. Reloading makes
    // the panel open its stream again, and that request fails. The poll still answers,
    // so the panel is reconnecting.
    await page.route("**/v1/owner/events", (route) => route.abort());
    await page.reload();
    await expect(badge).toHaveText("Reconnecting", { timeout: 15_000 });

    // The broker stops answering: the panel's own offline reply (proxy.ts).
    await page.route("**/v1/owner/events/poll**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: 5,
            message: "The homectl broker is not running.",
            reason: "broker-offline",
          },
        }),
      }),
    );
    await expect(badge).toHaveText("Offline", { timeout: 15_000 });

    // Made while the panel is offline: the broker holds it, the panel does not show it.
    await harness.requestCommand(argv);
    // Longer than one poll interval (3 s), so a poll would have shown it by now.
    await page.waitForTimeout(3_500);
    await expect(approvalItem(page, argv)).toHaveCount(0);
    expect(waitingFromTitle(await page.title())).toBe(before);

    // Restored: the panel catches up and the badge returns to Live.
    await page.unroute("**/v1/owner/events");
    await page.unroute("**/v1/owner/events/poll**");
    await expect(approvalItem(page, argv)).toHaveCount(1, { timeout: 20_000 });
    await expect(badge).toHaveText("Live", { timeout: 20_000 });
    expect(await page.title()).toBe(`(${before + 1}) homectl owner`);
    // Catching up again must not add the same request a second time.
    await page.waitForTimeout(3_500);
    await expect(approvalItem(page, argv)).toHaveCount(1);
    expect(await page.title()).toBe(`(${before + 1}) homectl owner`);
    // Clean up: deny the request this scenario left waiting, and check the broker
    // is back where this scenario found it.
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

// Every owner flow with the real broker, at both viewports.
export async function runOwnerFlowScenarios(harness: Harness) {
  for (const viewport of VIEWPORTS) {
    await runRememberScenario(harness, viewport);
    await runAttentionScenario(harness, viewport);
    await runOfflineScenario(harness, viewport);
  }
}
