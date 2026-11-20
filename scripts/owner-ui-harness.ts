// Shared pieces of the owner panel's browser checks: the stubbed workspace
// server, sign-in, and layout checks. The panel and the broker are real; the
// workspace and update routes are answered by Playwright stubs, because a
// disposable workspace server and an update route are not part of this smoke.
// Every decision and every owner request the panel sends is recorded so the
// checks can read the request.

import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export type Json = Record<string, unknown>;
export type Viewport = { width: number; height: number };

export interface Harness {
  browser: Browser;
  panelOrigin: string;
  password: string;
  // Creates a real approval / secret request through the broker (shared daemon).
  requestApproval(label: string): Promise<unknown>;
  requestSecret(label: string): Promise<unknown>;
}

export interface WorkspaceStub {
  clients: Json[];
  pending: Json[];
  // The decision history the server answers on /intents, newest first.
  intents: Json[];
  decisions: Json[];
  removed: string[];
  invites: number;
  // Clients asked for a backup, in order.
  backupRequests: string[];
  // Previews and restores as the server received them (password never kept).
  previews: Json[];
  restores: Json[];
  // Whether the held snapshot verifies. A failed snapshot is refused on restore.
  restoreVerified: boolean;
}

export const VIEWPORTS: {
  name: string;
  viewport: Viewport;
  mobile: boolean;
}[] = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, mobile: false },
  { name: "phone", viewport: { width: 390, height: 844 }, mobile: true },
];

export const RESTORE_CODE = "R8T-44MW";

export function workspaceStub(): WorkspaceStub {
  const now = Date.now();
  const expires = now + 10 * 60_000;
  return {
    clients: [
      {
        id: "ws-laptop",
        name: "Laptop",
        platform: "linux",
        joinedAt: now - 86_400_000,
        lastSeenAt: now - 5_000,
        stale: false,
        remoteApproval: true,
        vaultUnlocked: true,
        pending: 2,
        mirror: { lastSeq: 42, gaps: 0 },
        backupRequested: false,
        backup: {
          latestSeq: 7,
          latestAt: now - 3_600_000,
          count: 3,
          bytes: 4096,
          oldestAt: now - 86_400_000,
        },
      },
      {
        id: "ws-nas",
        name: "NAS",
        platform: "linux",
        joinedAt: now - 86_400_000,
        lastSeenAt: null,
        stale: true,
        remoteApproval: false,
        vaultUnlocked: false,
        pending: 0,
        mirror: { lastSeq: 5, gaps: 2 },
        backupRequested: false,
        backup: {
          latestSeq: null,
          latestAt: null,
          count: 0,
          bytes: 0,
          oldestAt: null,
        },
      },
    ],
    pending: [
      {
        origin: "ws-laptop",
        originName: "Laptop",
        id: "op-normal",
        client: "codex",
        host: "nas",
        argv: ["zfs", "scrub", "tank"],
        risk: "R2",
        fingerprint: "fp-normal",
        reason: "Matches the maintenance rule",
        stepUp: false,
        humanOnly: false,
        expiresAt: expires,
        // Requester text is plain text: markup stays visible as written.
        narrative: { untrusted: "Start the scrub. <b>not bold</b>" },
        intent: null,
      },
      {
        // Still with the Auto Mode reviewer: no verdict, so no remembered rule.
        origin: "ws-laptop",
        originName: "Laptop",
        id: "op-review",
        client: "claude",
        host: "nas",
        argv: ["zfs", "list"],
        risk: "R2",
        fingerprint: "fp-review",
        reason: "No rule matches yet",
        source: "review",
        stepUp: false,
        humanOnly: false,
        expiresAt: expires,
        intent: null,
      },
      {
        origin: "ws-laptop",
        originName: "Laptop",
        id: "op-stepup",
        client: "codex",
        host: "nas",
        argv: ["opaque-tool", "--apply"],
        risk: "R3",
        fingerprint: "fp-stepup",
        reason: "Unknown command needs step-up",
        stepUp: true,
        humanOnly: false,
        expiresAt: expires,
        intent: null,
      },
      {
        // The client refused the earlier decision: the owner may decide again.
        origin: "ws-laptop",
        originName: "Laptop",
        id: "op-refused",
        client: "codex",
        host: "nas",
        argv: ["docker", "restart", "sonarr"],
        risk: "R2",
        fingerprint: "fp-refused",
        reason: "Matches the maintenance rule",
        stepUp: false,
        humanOnly: false,
        expiresAt: expires,
        intent: {
          id: "intent-refused",
          decision: "approve-once",
          status: "refused",
          reason:
            "The plan changed on the client. Ask the agent to plan again.",
          expiresAt: expires,
        },
      },
      {
        // Delivered, not applied yet: both buttons wait.
        origin: "ws-laptop",
        originName: "Laptop",
        id: "op-delivered",
        client: "codex",
        host: "nas",
        argv: ["zfs", "snapshot", "tank@nightly"],
        risk: "R2",
        fingerprint: "fp-delivered",
        reason: "Matches the maintenance rule",
        stepUp: false,
        humanOnly: false,
        expiresAt: expires,
        intent: {
          id: "intent-delivered",
          decision: "deny-once",
          status: "delivered",
          expiresAt: expires,
        },
      },
    ],
    intents: [
      {
        id: "intent-refused",
        operationId: "op-refused",
        client: "ws-laptop",
        decision: "approve-once",
        status: "refused",
        reason: "The plan changed on the client. Ask the agent to plan again.",
        expiresAt: expires,
      },
      {
        id: "intent-delivered",
        operationId: "op-delivered",
        client: "ws-laptop",
        decision: "deny-once",
        status: "delivered",
        expiresAt: expires,
      },
      {
        id: "intent-yesterday",
        operationId: "op-yesterday",
        client: "ws-laptop",
        decision: "approve-once",
        status: "applied",
        expiresAt: now - 86_400_000,
      },
    ],
    decisions: [],
    removed: [],
    invites: 0,
    backupRequests: [],
    previews: [],
    restores: [],
    restoreVerified: true,
  };
}

// The versions the stub holds for Laptop. The latest is 7, the default.
export const SNAPSHOT_SEQS = [5, 6, 7];
const LATEST_SEQ = 7;

// The snapshot the stub holds for Laptop at one version, with one file the
// restore never writes. An older version is a different (smaller) snapshot.
function snapshotPreview(stub: WorkspaceStub, client: string, seq: number) {
  return {
    source: client,
    seq,
    createdAt: Date.now() - 3_600_000 * (LATEST_SEQ - seq + 1),
    bytes: seq === LATEST_SEQ ? 4096 : 2048,
    verified: stub.restoreVerified,
    problems: stub.restoreVerified
      ? []
      : ["The snapshot's integrity check failed at settings.json"],
    seqs: SNAPSHOT_SEQS,
    files: [
      { path: "settings.json", size: 2048, restorable: true },
      { path: "keys/laptop.meta", size: 812, restorable: true },
      { path: "live/sessions.json", size: 1024, restorable: false },
    ],
  };
}

// Answers the workspace owner routes the way the server does: the same checks
// for fingerprint, step-up and the owner password. The password must match the
// one the owner typed, so a wrong password is refused as the server refuses it.
export async function serveWorkspace(
  page: Page,
  stub: WorkspaceStub,
  password: string,
) {
  await page.route("**/v1/owner/workspace/**", async (route) => {
    const name = new URL(route.request().url()).pathname.replace(
      "/v1/owner/workspace/",
      "",
    );
    const body = (route.request().postDataJSON() ?? {}) as Json;
    const reply = (status: number, payload: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    const refuse = (message: string) =>
      reply(403, { error: { code: 3, message } });
    const ownerOk = () => body.password === password;
    const reasonOk = () =>
      typeof body.reason === "string" &&
      body.reason.trim().length > 0 &&
      body.reason.length <= 300;
    switch (name) {
      case "server":
        return reply(200, {
          id: "ws-server",
          name: "Home server",
          clients: stub.clients.length,
        });
      case "clients":
        return reply(200, stub.clients);
      case "pending":
        return reply(200, stub.pending);
      case "decide": {
        stub.decisions.push(body);
        const op = stub.pending.find(
          (item) =>
            item.id === body.operationId &&
            item.fingerprint === body.fingerprint,
        );
        if (!op)
          return refuse(
            "That operation is not waiting for approval with this fingerprint",
          );
        if (body.decision === "approve-once" && op.stepUp === true)
          return refuse(
            "This operation needs step-up; approve it on its own device",
          );
        // Like the server: one decision in flight per operation, refused ones aside.
        const current = op.intent as Json | null;
        if (
          current &&
          (current.status === "queued" || current.status === "delivered")
        )
          return refuse("This operation already has a decision on its way");
        const intent = {
          id: `intent-${stub.decisions.length}`,
          operationId: body.operationId,
          client: body.client,
          decision: body.decision,
          status: "queued",
          expiresAt: Date.now() + 120_000,
        };
        op.intent = {
          id: intent.id,
          decision: intent.decision,
          status: intent.status,
          expiresAt: intent.expiresAt,
        };
        stub.intents.unshift(intent);
        return reply(200, {
          ...intent,
          fingerprint: body.fingerprint,
          stepUp: false,
          createdAt: Date.now(),
        });
      }
      case "intents":
        return reply(200, { intents: stub.intents });
      case "invite":
        if (!ownerOk()) return refuse("Confirm with the owner password");
        stub.invites += 1;
        return reply(200, {
          code: "K7Q-29X4",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          server: { id: "ws-server", name: "Home server" },
        });
      case "remove": {
        if (!ownerOk()) return refuse("Confirm with the owner password");
        const id = String(body.client);
        stub.clients = stub.clients.filter((client) => client.id !== id);
        stub.pending = stub.pending.filter((item) => item.origin !== id);
        stub.removed.push(id);
        return reply(200, { removed: id });
      }
      case "backup-request": {
        // No password: asking a client to back up changes nothing sensitive.
        const id = String(body.client);
        const client = stub.clients.find((item) => item.id === id);
        if (!client) return refuse("Unknown workspace client");
        client.backupRequested = true;
        stub.backupRequests.push(id);
        return reply(200, { client: id, requested: true });
      }
      case "restore-preview": {
        if (!ownerOk()) return refuse("Confirm with the owner password");
        if (!reasonOk())
          return refuse("A restore needs a reason of 1 to 300 characters");
        const id = String(body.client);
        if (!stub.clients.some((item) => item.id === id))
          return refuse("No backups are held for that client");
        // Without seq the server previews its latest snapshot, as the panel sends
        // no seq for that. An unknown version is refused as the server words it.
        const seq = body.seq === undefined ? LATEST_SEQ : body.seq;
        if (!SNAPSHOT_SEQS.includes(seq as number))
          return refuse(`No backup at seq ${seq} for that client`);
        stub.previews.push({
          client: id,
          reason: body.reason,
          ...(body.seq === undefined ? {} : { seq: body.seq }),
        });
        return reply(200, snapshotPreview(stub, id, seq as number));
      }
      case "restore": {
        if (!ownerOk()) return refuse("Confirm with the owner password");
        if (!reasonOk())
          return refuse("A restore needs a reason of 1 to 300 characters");
        const id = String(body.client);
        if (!stub.clients.some((item) => item.id === id))
          return refuse("No backups are held for that client");
        if (!SNAPSHOT_SEQS.includes(body.seq as number))
          return refuse(`No backup at seq ${body.seq} for that client`);
        if (!stub.restoreVerified)
          return refuse(
            "This snapshot does not verify. Nothing was restored and the client is not revoked.",
          );
        // The source is revoked only once its snapshot verified.
        stub.clients = stub.clients.filter((item) => item.id !== id);
        stub.pending = stub.pending.filter((item) => item.origin !== id);
        stub.removed.push(id);
        stub.restores.push({
          client: id,
          seq: body.seq,
          reason: body.reason,
        });
        return reply(200, {
          code: RESTORE_CODE,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          restore: { source: id, seq: body.seq, files: 2, bytes: 2860 },
          server: { id: "ws-server", name: "Home server" },
        });
      }
      default:
        return reply(404, { error: { code: 2, message: "Not found" } });
    }
  });
}

export async function signIn(page: Page, harness: Harness) {
  await page.goto(`${harness.panelOrigin}/`);
  await page.getByLabel("Owner password").fill(harness.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: /Nothing needs you|Needs you/ }),
  ).toBeVisible({ timeout: 15_000 });
}

export async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// Opens a context at one viewport. `init` runs in the page before its scripts.
export async function open<Arg>(
  harness: Harness,
  viewport: { name: string; viewport: Viewport; mobile: boolean },
  init?: { script: (arg: Arg) => void; arg: Arg },
) {
  const context: BrowserContext = await harness.browser.newContext({
    viewport: viewport.viewport,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  // The argument is plain JSON, so the script is sent as text with it inlined.
  if (init)
    await context.addInitScript({
      content: `(${init.script.toString()})(${JSON.stringify(init.arg)});`,
    });
  return { context, page: await context.newPage() };
}
