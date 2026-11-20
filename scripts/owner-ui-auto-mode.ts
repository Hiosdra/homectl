// Browser checks for Auto Mode settings under Permissions (homelab #21 A1). The
// broker's routes are answered by a stub that applies the same step-up rules the
// broker does: a wider authority, turning Auto on, or a new endpoint needs the
// owner password, and a refusal changes nothing. The panel must send no password
// on its first try and ask for it only after the refusal.

import { expect, type Page } from "@playwright/test";
import {
  type Harness,
  type Json,
  noOverflow,
  open,
  signIn,
  type VIEWPORTS,
} from "./owner-ui-harness";

type Viewport = (typeof VIEWPORTS)[number];
type Mode = "manual" | "rules" | "auto";
type Authority = "recommend" | "routine" | "delegated";

export interface AutoModeStub {
  revision: number;
  mode: Mode;
  authority: Authority;
  // The origin only, as the broker shows it.
  endpoint?: string;
  model?: string;
  // Every save request the panel sent, in order, password included.
  saves: Json[];
}

const RANK: Record<Authority, number> = {
  recommend: 0,
  routine: 1,
  delegated: 2,
};

function viewOf(stub: AutoModeStub): Json {
  return {
    revision: stub.revision,
    mode: stub.mode,
    reviewer: {
      authority: stub.authority,
      fallback: "ask",
      maxRisk: "R2",
      ...(stub.endpoint === undefined ? {} : { endpoint: stub.endpoint }),
      ...(stub.model === undefined ? {} : { model: stub.model }),
      apiKeyConfigured: true,
      ready: stub.endpoint !== undefined && stub.model !== undefined,
    },
    choices: {
      modes: ["manual", "rules", "auto"],
      authorities: ["recommend", "routine", "delegated"],
    },
  };
}

// Answers the Auto Mode routes. A refusal leaves the settings as they were.
export async function serveAutoMode(
  page: Page,
  stub: AutoModeStub,
  password: string,
) {
  await page.route("**/v1/owner/auto-mode/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (status: number, payload: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    if (path.endsWith("/get")) return reply(200, viewOf(stub));
    const body = (route.request().postDataJSON() ?? {}) as Json;
    stub.saves.push(body);
    const next: AutoModeStub = { ...stub };
    if (typeof body.mode === "string") next.mode = body.mode as Mode;
    if (typeof body.authority === "string")
      next.authority = body.authority as Authority;
    if (body.endpoint === null) delete next.endpoint;
    else if (typeof body.endpoint === "string")
      next.endpoint = new URL(body.endpoint).origin;
    if (typeof body.model === "string") next.model = body.model;
    const widens = RANK[next.authority] > RANK[stub.authority];
    const enablesAuto = next.mode === "auto" && stub.mode !== "auto";
    const newEndpoint =
      typeof body.endpoint === "string" && next.endpoint !== stub.endpoint;
    if ((widens || enablesAuto || newEndpoint) && body.password !== password)
      return reply(403, {
        error: { code: 3, message: "Confirm with the owner password" },
      });
    next.revision = stub.revision + 1;
    Object.assign(stub, next);
    return reply(200, viewOf(stub));
  });
}

export async function runAutoModeScenario(
  harness: Harness,
  viewport: Viewport,
) {
  const stub: AutoModeStub = {
    revision: 1,
    mode: "rules",
    authority: "recommend",
    endpoint: "https://reviewer.example.test",
    model: "reviewer-model",
    saves: [],
  };
  const { context, page } = await open(harness, viewport);
  try {
    await serveAutoMode(page, stub, harness.password);
    await signIn(page, harness);
    await page
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    const section = page.getByRole("region", { name: "Auto Mode settings" });
    await expect(section).toBeVisible({ timeout: 10_000 });

    // What the owner is told: the reviewer is not an approval, the origin only,
    // and whether a key is configured (never the key).
    await expect(
      section.getByText(/The reviewer's verdict is not a human approval/),
    ).toBeVisible();
    await expect(
      section.getByText(/Human-only operations and step-up operations never/),
    ).toBeVisible();
    await expect(
      section.getByText("https://reviewer.example.test", { exact: false }),
    ).toBeVisible();
    await expect(
      section.getByText("Configured", { exact: true }),
    ).toBeVisible();

    // Least privilege is what the form opens on: the saved settings.
    await expect(section.getByLabel("Mode", { exact: true })).toHaveValue(
      "rules",
    );
    await expect(section.getByLabel("Reviewer may")).toHaveValue("recommend");
    const save = section.getByRole("button", {
      name: "Save Auto Mode settings",
    });
    await expect(save).toBeDisabled();

    // A change that needs no step-up is saved without asking for a password.
    await section.getByLabel("Mode", { exact: true }).selectOption("manual");
    await save.click();
    await expect(section.getByText("Saved. Policy revision 2.")).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.saves[0]).toEqual({ mode: "manual" });

    // Raising the reviewer's authority is refused without the password. The
    // panel then asks for it, and the retry carries it.
    await section.getByLabel("Reviewer may").selectOption("routine");
    await section
      .getByRole("button", { name: "Save Auto Mode settings" })
      .click();
    await expect(
      section.getByText(/This change needs your owner password/),
    ).toBeVisible({ timeout: 10_000 });
    const confirm = section.getByRole("button", { name: "Confirm and save" });
    await expect(confirm).toBeDisabled();
    await section.getByLabel("Owner password").fill(harness.password);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(section.getByText("Saved. Policy revision 3.")).toBeVisible({
      timeout: 10_000,
    });
    expect(stub.authority).toBe("routine");

    // A new endpoint: a wrong password is refused and nothing changes.
    await section
      .getByLabel(/Reviewer endpoint/)
      .fill("https://other-reviewer.example.test/v1");
    await section
      .getByRole("button", { name: "Save Auto Mode settings" })
      .click();
    await section.getByLabel("Owner password").fill("not the owner password");
    await section.getByRole("button", { name: "Confirm and save" }).click();
    await expect(
      section.getByText(
        "That owner password was not accepted. Nothing changed.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    expect(stub.endpoint).toBe("https://reviewer.example.test");

    // The right password saves it; the origin is what is shown afterwards.
    await section.getByLabel("Owner password").fill(harness.password);
    await section.getByRole("button", { name: "Confirm and save" }).click();
    await expect(section.getByText("Saved. Policy revision 4.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      section.getByText("https://other-reviewer.example.test (origin only)"),
    ).toBeVisible();

    // The password was sent only on the attempts that needed it, never on the
    // first try of a change, and each attempt was sent once.
    expect(stub.saves.map((save) => "password" in save)).toEqual([
      false, // manual: no step-up
      false, // routine: refused for want of the password
      true, // routine with the password
      false, // new endpoint: refused for want of the password
      true, // new endpoint, wrong password
      true, // new endpoint, right password
    ]);
    expect(page.url()).not.toContain(harness.password);
    await noOverflow(page);
  } finally {
    await context.close();
  }
}
